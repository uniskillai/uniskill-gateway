// src/routes/crypto_util.ts
import { corsHeaders } from "../utils/response";
import type { Env } from "../index";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";

export async function handleCrypto(request: Request, _env: Env): Promise<Response> {
    if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    try {
        const body: any = await request.json();
        const operation = body.operation || body.action;
        const data = body.data;

        if (!operation) {
            return new Response(JSON.stringify({ error: "Missing required parameter: operation" }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        let result: string | null = null;
        const normalizedOp = operation.toLowerCase();

        switch (normalizedOp) {
            case "uuid_v4":
            case "uuid":
                result = crypto.randomUUID();
                break;
            case "base64_encode":
                if (data === undefined) throw new Error("Missing 'data' parameter for base64_encode");
                result = Buffer.from(data, "utf-8").toString("base64");
                break;
            case "base64_decode":
                if (data === undefined) throw new Error("Missing 'data' parameter for base64_decode");
                result = Buffer.from(data, "base64").toString("utf-8");
                break;
            case "md5":
                if (data === undefined) throw new Error("Missing 'data' parameter for md5");
                const md5Hash = await crypto.subtle.digest("MD5", Buffer.from(data, "utf-8"));
                result = Array.from(new Uint8Array(md5Hash)).map(b => b.toString(16).padStart(2, '0')).join('');
                break;
            case "sha256":
                if (data === undefined) throw new Error("Missing 'data' parameter for sha256");
                const sha256Hash = await crypto.subtle.digest("SHA-256", Buffer.from(data, "utf-8"));
                result = Array.from(new Uint8Array(sha256Hash)).map(b => b.toString(16).padStart(2, '0')).join('');
                break;
            default:
                return new Response(JSON.stringify({ error: `Unsupported operation: ${operation}` }), {
                    status: 400,
                    headers: { ...corsHeaders, "Content-Type": "application/json" }
                });
        }

        return new Response(JSON.stringify({
            status: "success",
            operation: operation,
            result: result
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
