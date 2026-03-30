import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const DEEPSEEK_API_KEY = Deno.env.get('DEEPSEEK_API_KEY');
const VOYAGE_API_KEY = Deno.env.get('VOYAGE_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

// Initialize Supabase Client with Service Role (Bypass RLS)
const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

interface DiagnosisResult {
    summary: string;
    pattern: string;
    patch: string;
}

serve(async (req: Request) => {
    console.log("[EvolveCritic] Starting evolution cycle...");

    if (!DEEPSEEK_API_KEY || !VOYAGE_API_KEY) {
        console.error("Missing API Keys for DeepSeek or Voyage.");
        return new Response(JSON.stringify({ error: "Missing API Keys." }), { status: 500 });
    }

    try {
        // 1. 捞取最近的未分析错误日志 (限制 5 条)
        const { data: errorLogs, error: fetchError } = await supabase
            .from('invocations')
            .select('id, skill_uid, user_uid, input_payload, output_payload')
            .eq('status', 'error')
            .is('analyzed_at', null)
            .order('created_at', { ascending: false })
            .limit(5);

        if (fetchError) {
            console.error("Failed to fetch invocation logs:", fetchError);
            return new Response(JSON.stringify({ error: fetchError.message }), { status: 500 });
        }

        if (!errorLogs || errorLogs.length === 0) {
            console.log("[EvolveCritic] No new errors to analyze.");
            return new Response(JSON.stringify({ message: "No new errors to analyze." }), { status: 200 });
        }

        console.log(`[EvolveCritic] Found ${errorLogs.length} unanalyzed errors. Processing...`);

        // Array to hold execution summary
        const executionStats = { processed: 0, distinct: 0, duplicates: 0, failed: 0 };

        for (const log of errorLogs) {
            console.log(`\n--- Processing Log: ${log.id} ---`);
            try {
                // 1. 降噪清洗 (Input Pruning): 剔除诸如 session_id, trace_id, timestamp 无意义噪音
                const prunedInput = { ... (log.input_payload || {}) };
                const noiseKeys = ['session_id', 'request_id', 'trace_id', 'timestamp', 'nonce'];
                for (const key of Object.keys(prunedInput)) {
                    if (noiseKeys.some(nk => key.toLowerCase().includes(nk))) {
                        delete prunedInput[key];
                    }
                }
                
                // 2. 构造双重签名 (Dual Signature)
                const inputSignature = `Input: ${JSON.stringify(prunedInput)}`;
                const errorSignature = `Error: ${JSON.stringify(log.output_payload || {})}`;
                
                // 3. 生成双重向量 (Voyage Embeddings 1536维 特性)
                // Voyage 支持数组并发向量化，一口气拿到两组特征
                const embeddingResponse = await fetch("https://api.voyageai.com/v1/embeddings", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${VOYAGE_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        input: [inputSignature, errorSignature],
                        model: "voyage-code-3",
                        output_dimension: 1536 
                    })
                });

                if (!embeddingResponse.ok) {
                    throw new Error(`Voyage AI Embedding API failed: ${await embeddingResponse.text()}`);
                }
                
                const embeddingData = await embeddingResponse.json();
                const inputVector = embeddingData.data[0].embedding;
                const errorVector = embeddingData.data[1].embedding;

                // 4. 前置排重拦截 (Deduplication): 依据错误堆栈查询是否已有类似教训 (>0.95 相似度)
                const { data: matchData, error: matchError } = await supabase
                    .rpc('match_learnings_by_error', {
                        query_embedding: errorVector,
                        match_threshold: 0.95, // 95% threshold for exact errors
                        match_count: 1
                    });

                let duplicateFoundId: string | null = null;
                
                if (matchError) {
                    console.warn(`[EvolveCritic] RPC match error (ignoring and proceeding as distinct):`, matchError.message);
                } else if (matchData && matchData.length > 0) {
                    duplicateFoundId = matchData[0].id;
                    console.log(`[EvolveCritic] 🔄 Semantic match found (Score: ${(matchData[0].similarity as number).toFixed(3)}) with Learning ID: ${duplicateFoundId}`);
                }

                if (duplicateFoundId) {
                    // => 命中复发错误。仅仅更新原有教训的更新时间
                    await supabase
                        .from('skill_learnings')
                        .update({ updated_at: new Date().toISOString() })
                        .eq('id', duplicateFoundId);

                    executionStats.duplicates++;
                    console.log(`[EvolveCritic] Updated existing learning. Touched timestamp.`);

                } else {
                    // => 这是个新物种。呼叫 DeepSeek 分析。
                    console.log(`[EvolveCritic] 🆕 Unseen error pattern. Triggering DeepSeek diagnosis...`);
                    
                    const analysisResponse = await fetch("https://api.deepseek.com/chat/completions", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${DEEPSEEK_API_KEY}`
                        },
                        body: JSON.stringify({
                            model: "deepseek-chat", // DeepSeek V3/V2 depending on availability
                            messages: [
                                {
                                    role: "system",
                                    content: "You are an elite AI Debugger for the UniSkill Gateway. Analyze the following failure data precisely. Provide a structured JSON response exactly matching this format:\n{\n  \"summary\": \"Brief task description and context\",\n  \"pattern\": \"Root cause of what went wrong technically\",\n  \"patch\": \"Actionable advice for fixing it or defensive programming pattern next time\"\n}"
                                },
                                {
                                    role: "user",
                                    content: `Input Context:\n${inputSignature}\n\nError Faced:\n${errorSignature}`
                                }
                            ],
                            response_format: { type: 'json_object' }
                        })
                    });

                    if (!analysisResponse.ok) {
                        throw new Error(`DeepSeek API failed: ${await analysisResponse.text()}`);
                    }

                    const analysisData = await analysisResponse.json();
                    const rawContent = analysisData.choices[0].message.content;
                    
                    // JSON 顽固清洗：防止 Markdown 闭环或杂质
                    const cleanJson = rawContent.replace(/```json|```/g, "").trim();
                    const diagnosis = JSON.parse(cleanJson) as DiagnosisResult;
                    
                    if (!diagnosis.summary || !diagnosis.pattern || !diagnosis.patch) {
                        throw new Error(`Invalid JSON schema from DeepSeek. Keys missing.`);
                    }

                    // 存入 skill_learnings 知识库 (Dual Vector)
                    const { error: insertError } = await supabase.from('skill_learnings').insert({
                        skill_uid: log.skill_uid,
                        user_uid: log.user_uid,
                        task_description: diagnosis.summary,
                        error_pattern: diagnosis.pattern,
                        solution_patch: diagnosis.patch,
                        input_embedding: inputVector,
                        error_embedding: errorVector
                    });

                    if (insertError) {
                        throw new Error(`Failed to insert into skill_learnings: ${insertError.message}`);
                    }
                    
                    executionStats.distinct++;
                    console.log(`[EvolveCritic] Inserted new semantic learning successfully.`);
                }

                // 5. 将原生 invocations 标记为已完成净化分析 (无论是去重还是新增，都视为处理完)
                await supabase
                    .from('invocations')
                    .update({ analyzed_at: new Date().toISOString() })
                    .eq('id', log.id);

                executionStats.processed++;

            } catch (err: any) {
                executionStats.failed++;
                console.error(`[EvolveCritic] ❌ Fatal error processing log ${log.id}:`, err.message);
                // Continue to the next log gracefully, leaving this one's analyzed_at as null.
            }
        }

        console.log(`\n[EvolveCritic] Cycle complete: processed=${executionStats.processed}, distinct=${executionStats.distinct}, duplicates=${executionStats.duplicates}, failed=${executionStats.failed}`);

        return new Response(JSON.stringify({ 
            message: "Evolution cycle completed.", 
            stats: executionStats 
        }), { status: 200, headers: { "Content-Type": "application/json" } });

    } catch (unexpectedError: any) {
        console.error("[EvolveCritic] Unexpected Global Error:\n", unexpectedError);
        return new Response(JSON.stringify({ error: unexpectedError.message }), { status: 500 });
    }
});
