// scripts/test-auto-workflow.ts
// 职责：验证 uniskill_auto_workflow 元技能的完整功能
// 运行方式：npx tsx scripts/test-auto-workflow.ts

const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:8787";
const API_KEY = process.env.UNISKILL_API_KEY || "";

if (!API_KEY) {
    console.error("❌ 请设置环境变量 UNISKILL_API_KEY=us-xxxxxxxx");
    process.exit(1);
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

async function callAutoWorkflow(goal: string, label: string): Promise<void> {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`🧪 测试用例：${label}`);
    console.log(`📝 Goal: "${goal}"`);
    console.log(`${"─".repeat(60)}`);

    const startTime = Date.now();

    try {
        const res = await fetch(`${GATEWAY_URL}/v1/execute/uniskill_auto_workflow`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ goal }),
        });

        const elapsed = Date.now() - startTime;
        const body = await res.json() as any;

        console.log(`⏱  响应时间: ${elapsed}ms`);
        console.log(`📊 HTTP 状态: ${res.status}`);

        if (!res.ok) {
            console.log(`❌ 请求失败:`, body);
            return;
        }

        // 核心返回字段
        const data = body; // execute-skill 会包一层
        const innerData = data.result !== undefined ? data : (data._uniskill ? data : body);

        // _uniskill 元信息
        if (body._uniskill) {
            console.log(`\n💳 计费信息:`);
            console.log(`   - credits_charged: ${body._uniskill.credits_charged}`);
            console.log(`   - remaining: ${body._uniskill.remaining}`);
            console.log(`   - request_id: ${body._uniskill.request_id}`);
        }

        // execution_trace（可能嵌套在不同位置）
        const payload = body;
        const trace = payload.execution_trace ||
                      payload.result?.execution_trace ||
                      payload._uniskill?.metadata?.execution_trace;

        if (trace && Array.isArray(trace)) {
            console.log(`\n🔍 Execution Trace (${trace.length} 步):`);
            for (const entry of trace) {
                const icon = entry.action === "call_tool" ? "🔧"
                    : entry.action === "finish" ? "✅"
                    : entry.action === "partial_finish" ? "⚠️"
                    : "❌";
                console.log(`\n   ${icon} Step ${entry.step}: ${entry.action}`);
                if (entry.tool) console.log(`      工具: ${entry.tool}`);
                if (entry.params) console.log(`      参数: ${JSON.stringify(entry.params)}`);
                if (entry.result) console.log(`      结果: ${JSON.stringify(entry.result).slice(0, 200)}`);
                if (entry.error) console.log(`      错误: ${entry.error}`);
                console.log(`      耗时: ${entry.duration_ms}ms`);
            }
        }

        // 最终结果
        const finalResult = payload.result || payload.partial_result;
        if (finalResult) {
            console.log(`\n✨ 最终结果:\n   ${finalResult}`);
        }

        const terminatedEarly = payload.terminated_early || payload.result?.terminated_early;
        if (terminatedEarly) {
            console.log(`\n⚠️  提前终止 (原因: ${payload.reason || "unknown"})`);
        }

        const iters = payload.iterations_completed || payload.result?.iterations_completed;
        if (iters !== undefined) {
            console.log(`\n📈 完成迭代数: ${iters}`);
        }

        console.log(`\n✅ 测试用例 "${label}" 完成`);

    } catch (e: any) {
        console.error(`❌ 请求异常:`, e.message);
    }
}

// ── 测试矩阵 ──────────────────────────────────────────────────────────────────

async function main() {
    console.log("🚀 UniSkill Auto-Workflow 测试套件");
    console.log(`Gateway: ${GATEWAY_URL}`);

    // TC1: 单步 Goal — 验证基础 ReAct 流程
    await callAutoWorkflow(
        "现在北京时间是几点？",
        "TC1: 单步 Goal (时间查询)"
    );

    // TC2: 多步 Goal — 验证 Observation → 规划链路
    await callAutoWorkflow(
        "查询上海当前天气，然后根据天气情况推荐是否适合户外跑步",
        "TC2: 多步 Goal (天气 → 建议)"
    );

    // TC3: Self-Healing 验证 — 故意传不完整参数
    await callAutoWorkflow(
        "帮我查北京纬度，使用 uniskill_geo 工具，城市名用英文",
        "TC3: Self-Healing (地理查询)"
    );

    // TC4: 工具不存在 — 验证错误 Observation 处理
    await callAutoWorkflow(
        "帮我把 42 摄氏度转换成华氏度",
        "TC4: 数学计算 (Math 工具)"
    );

    console.log(`\n${"═".repeat(60)}`);
    console.log("🏁 所有测试用例执行完毕");
    console.log(`${"═".repeat(60)}`);
}

main().catch(console.error);
