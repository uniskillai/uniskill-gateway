import { createClient } from '@supabase/supabase-js';

// 🌟 核心定义：严格的三层业务状态类型 (Strict Tri-state Enum)
export type ExecutionTxStatus = {
    status_code: number;
    execution_status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
    error_message: string | null;
    latency_ms: number;       // 🌟 耗时监测
    metadata: any;            // 🌟 诊断诊断 JSONB 信息
};

/**
 * Initialize Supabase client
 */
const getSupabaseClient = (env: any) => {
    // 逻辑：记账属于高权限后端操作，优先使用 SERVICE_ROLE_KEY 绕过 RLS 限制
    const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
    return createClient(env.SUPABASE_URL, key);
};

/**
 * Records skill usage in Supabase using the integrated 'skills' table.
 * Supports dual-dimension statistics (credits/usd) and tri-state error logging.
 */
export async function recordSkillCall(
    env: any, 
    userUid: string,
    skillName: string, 
    requestId: string,
    credits: number = 0, 
    paymentType: 'credits' | 'usd' = 'credits', 
    txStatus: ExecutionTxStatus,  // 🌟 核心替换：使用结构化的状态对象
    creditsPerCall?: number,
    display_name?: string, 
    tags?: string[]       
): Promise<void> {
    const supabase = getSupabaseClient(env);

    try {
        // 逻辑：调用 Supabase RPC 记录调用，并将状态对象拆解为独立字段
        const { error } = await supabase.rpc('record_skill_usage', {
            p_user_uid: userUid,
            p_skill_name: skillName,
            p_payment_type: paymentType,
            p_request_id: requestId,
            p_cost: credits,
            
            // 🌟 状态与诊断字段拆解
            p_status_code: txStatus.status_code,
            p_execution_status: txStatus.execution_status,
            p_error_message: txStatus.error_message,
            p_latency_ms: txStatus.latency_ms,
            p_metadata: txStatus.metadata,
            
            p_credits_per_call: creditsPerCall,
            p_display_name: display_name,
            p_tags: tags
        });

        if (error) {
            console.error(`[Stats] RPC error [${paymentType}] for [${skillName}] user [${userUid.slice(-6)}]:`, error.message);
        } else {
            console.log(`[Stats] Recorded: [${paymentType}] skill=${skillName} latency=${txStatus.latency_ms}ms status=${txStatus.execution_status} user=...${userUid.slice(-6)}`);
        }
    } catch (err) {
        console.error(`[Stats] Unexpected error recording call for ${skillName}:`, err);
    }
}
