// src/routes/time.ts
import { corsHeaders } from "../utils/response";
import type { Env } from "../index";

export async function handleTime(request: Request, _env: Env): Promise<Response> {
    if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    try {
        const body: any = await request.json();
        const timezone = body.timezone || "UTC";

        // Validate timezone format
        try {
            Intl.DateTimeFormat(undefined, { timeZone: timezone });
        } catch (e) {
            return new Response(JSON.stringify({ error: `Invalid timezone format: ${timezone}` }), {
                status: 400,
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }

        const now = new Date();
        
        // Format to a highly localized and structured output for the LLM
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: 'long',
            day: '2-digit',
            weekday: 'long',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZoneName: 'longOffset'
        });

        const localizedString = formatter.format(now);
        const isoString = new Date(now.toLocaleString("en-US", {timeZone: timezone})).toISOString();

        return new Response(JSON.stringify({
            status: "success",
            timezone: timezone,
            current_time: localizedString,
            iso_8601: isoString,
            unix_timestamp: Math.floor(now.getTime() / 1000)
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
