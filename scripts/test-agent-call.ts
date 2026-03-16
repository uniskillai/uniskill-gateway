import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";

// Load environment variables for test wallet if needed
dotenv.config({ path: path.join(process.cwd(), ".dev.vars") });

// A dummy private key for local testing. In reality, the Agent controls its own key.
// Address for this private key is: 0xfA90a817E010BD2665C04A6D1d2Ba3fAcd30eFEB
const TEST_PRIVATE_KEY = process.env.TEST_PRIVATE_KEY || "0x1234567890123456789012345678901234567890123456789012345678901234";

async function testAgentCall() {
    console.log("🤖 Wild Agent Test Tool\n");

    const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);
    const agentAddress = wallet.address;
    console.log(`[Agent] Initialized with Wallet: ${agentAddress}`);

    const targetSkill = "uniskill_math";
    const payload = {
        skill_name: targetSkill,
        params: {
            expression: "42 * 10 / 2"
        }
    };

    // 1. Generate Timestamp (Unix seconds)
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // 2. Cryptographic Signature
    // Message must be '{skill_id}:{timestamp}' as per UniSkill 402 challenge
    const messageToSign = `${targetSkill}:${timestamp}`; 
    console.log(`[Agent] Signing message: ${messageToSign}`);
    
    const signature = await wallet.signMessage(messageToSign);
    console.log(`[Agent] Signature Generated:\n${signature}\n`);

    // 3. Make the API Call to Gateway
    const gatewayUrl = "https://uniskill-gateway-staging.geekpro798.workers.dev/v1/execute";
    console.log(`[Agent] Calling Gateway: ${gatewayUrl} for skill [${targetSkill}]...`);

    try {
        const response = await fetch(gatewayUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Agent-Wallet": agentAddress,
                "X-NVM-Signature": signature,
                "X-NVM-Timestamp": timestamp,
                "Authorization": `Bearer ${signature}` // Fallback generic auth if needed
            },
            body: JSON.stringify(payload)
        });

        const status = response.status;
        const data = await response.text();

        console.log(`\n[Gateway Response] Status: ${status}`);
        try {
            console.log(JSON.stringify(JSON.parse(data), null, 2));
        } catch {
            console.log(data);
        }

    } catch (error: any) {
        console.error("❌ Failed to reach gateway:", error.message);
    }
}

testAgentCall();
