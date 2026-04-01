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
    txStatus: ExecutionTxStatus,  
    creditsPerCall?: number,
    display_name?: string, 
    tags?: string[],
    skillUid?: string | null     
): Promise<void> {
    const supabase = getSupabaseClient(env);
    const OFFICIAL_UUID = '00000000-0000-0000-0000-000000000001';
    
    // UUID Validator
    const isUUID = (uuid: any) => typeof uuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);

    try {
        const rpcPayload = {
            p_user_uid: isUUID(userUid) ? userUid : OFFICIAL_UUID,
            p_skill_name: skillName,
            p_source_skill_uid: isUUID(skillUid) ? skillUid : OFFICIAL_UUID, 
            p_payment_type: paymentType,
            p_request_id: requestId,
            p_cost: credits,
            
            // 🌟 状态与诊断字段拆解
            p_status_code: txStatus.status_code,
            p_execution_status: txStatus.execution_status,
            p_error_message: txStatus.error_message,
            p_latency_ms: txStatus.latency_ms,
            p_metadata: { 
                trace: txStatus.metadata || [],
                original_skill: skillUid || skillName,
                original_user: userUid
            }, 
            
            p_credits_per_call: creditsPerCall,
            p_display_name: display_name,
            p_tags: tags
        };

        // 🌟 诊断日志：在发送前打印完整 Payload
        console.log(`[Stats][Diagnostic] Sending RPC to Supabase for ${skillName}...`);
        // console.log(`[Stats][Payload] ${JSON.stringify(rpcPayload)}`); // 调试时可开启

        // 逻辑：调用 Supabase RPC 记录调用
        const { error } = await supabase.rpc('record_skill_usage', rpcPayload);

        if (error) {
            console.error(`[Stats] RPC error [${paymentType}] for [${skillName}] status:`, {
                code: error.code,
                message: error.message,
                details: error.details,
                hint: error.hint
            });
        } else {
            const shortUid = (userUid && typeof userUid === 'string') ? userUid.slice(-6) : 'anon';
            console.log(`[Stats] Recorded: [${paymentType}] skill=${skillName} latency=${txStatus.latency_ms}ms status=${txStatus.execution_status} user=...${shortUid}`);
        }
    } catch (err) {
        console.error(`[Stats] Unexpected error recording call for ${skillName}:`, err);
    }
}
