// src/routes/math.ts
import { corsHeaders } from "../utils/response";
import type { Env } from "../index";

export async function handleMath(request: Request, _env: Env): Promise<Response> {
    if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    try {
        const body: any = await request.json();
        const expr = body.expr || body.expression;

        if (!expr) {
            return new Response(JSON.stringify({ error: "Missing required parameter: expr" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        // Use the free mathjs API for 100% accurate evaluations
        const targetUrl = new URL("https://api.mathjs.org/v4/");
        targetUrl.searchParams.append("expr", expr);

        const apiResponse = await fetch(targetUrl.toString(), {
            method: "GET",
        });

        if (!apiResponse.ok) {
            const errorText = await apiResponse.text();
            throw new Error(`Math API Error: ${errorText}`);
        }

        const resultText = await apiResponse.text();

        return new Response(JSON.stringify({
            status: "success",
            expression: expr,
            result: resultText,
        }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }
}
