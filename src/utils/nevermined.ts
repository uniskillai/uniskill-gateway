/**
 * Nevermined Pay-As-You-Go SDK Integration
 * 
 * Handles dynamic signature verification, pre-flight balance checks,
 * and deterministic settlement for Autonomous Agents.
 */

// Helper to interact with Nevermined Payments API
const getPaymentsApi = (_apiKey: string) => {
    // Both production and sandbox use the same host, identified by the key prefix
    return 'https://payments.nevermined.app/api/v1';
};

export interface NvmPreFlightRequest {
    agentAddress: string;
    signature: string;
    timestamp: string;
    costUsd: number;
    skillId: string;
}

export interface NvmSettlementRequest extends NvmPreFlightRequest {
    isSuccess: boolean;
}

/**
 * Step 3: Pre-flight Ledger Check
 * Query Nevermined node to verify signature and check if balance >= cost
 */
export async function verifyNeverminedBalance(
    env: any, 
    req: NvmPreFlightRequest
): Promise<{ isAllowed: boolean; agentWallet: string; message?: string }> {
    try {
        const apiKey = env.NVM_API_KEY;
        const planDid = env.NEVERMINED_PLAN_ID;

        if (!apiKey || !planDid) {
            console.error('[NVM] Missing NVM_API_KEY or NEVERMINED_PLAN_ID in env');
            return { isAllowed: false, agentWallet: req.agentAddress, message: 'Gateway Misconfigured' };
        }

        // TODO: Replace with official @nevermined-io/sdk method if available for Workers
        // We do a REST call to NVM Payments API to verify the signature and balance
        const nvmApi = getPaymentsApi(apiKey);
        const response = await fetch(`${nvmApi}/payments/proxy/verify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                did: planDid,
                consumer_address: req.agentAddress,
                signature: req.signature,
                timestamp: /^\d+$/.test(req.timestamp) ? parseInt(req.timestamp, 10) : req.timestamp,
                amount: req.costUsd
            })
        });

        if (!response.ok) {
            const errBody = await response.text();
            console.error(`[NVM] Pre-flight check failed: ${response.status} - ${errBody}`);
            
            let message = 'Verification Failed';
            if (response.status === 402) message = 'Insufficient Funds';
            if (response.status === 401) message = 'Invalid Signature';
            
            return { isAllowed: false, agentWallet: req.agentAddress, message: `${message} (${response.status})` };
        }

        const data = await response.json() as any;
        return { 
            isAllowed: data.is_valid === true || data.success === true, 
            agentWallet: req.agentAddress 
        };

    } catch (error: any) {
        console.error('[NVM] Exception during verifyNeverminedBalance:', error.message);
        return { isAllowed: false, agentWallet: req.agentAddress, message: 'NVM Node Error' };
    }
}

/**
 * Step 4: Deterministic Settlement
 * If execution succeeded, push trace to Nevermined to settle the payment.
 */
export async function settleNeverminedPayment(
    env: any,
    req: NvmSettlementRequest
): Promise<boolean> {
    try {
        if (!req.isSuccess) {
            console.log(`[NVM] Execution failed for ${req.agentAddress}, skipping settlement.`);
            return false;
        }

        const apiKey = env.NVM_API_KEY;
        const planDid = env.NEVERMINED_PLAN_ID;

        // Push trace to settle the transaction
        const nvmApi = getPaymentsApi(apiKey);
        const response = await fetch(`${nvmApi}/traces`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                did: planDid,
                consumer_address: req.agentAddress,
                amount: req.costUsd,
                signature: req.signature,
                timestamp: req.timestamp,
                status: 'success'
            })
        });

        if (!response.ok) {
            console.error(`[NVM] Settlement failed for ${req.agentAddress}: ${response.status}`);
            return false;
        }

        console.log(`[NVM] Successfully settled ${req.costUsd} USD for ${req.agentAddress}`);
        return true;

    } catch (error: any) {
        console.error('[NVM] Exception during settleNeverminedPayment:', error.message);
        return false;
    }
}
