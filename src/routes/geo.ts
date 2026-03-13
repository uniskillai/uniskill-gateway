import { Env } from "../engine/executor";
import { successResponse, errorResponse } from "../utils/response";

export async function handleGeo(request: Request, env: Env): Promise<Response> {
    try {
        const body: any = await request.json();
        const target = (body?.target || body?.ip || body?.address || body?.location)?.toString()?.trim();

        let lat: number | null = null;
        let lon: number | null = null;
        let addressStr = "";
        let timezoneStr = "UTC"; // Default

        // ── 1. Determine Target & Get Coordinates ──
        if (!target) {
            // Implicit Strategy (Zero Friction): Use Cloudflare request.cf
            console.log(`[uniskill_geo] Implicit lookup via request.cf`);
            const cf = request.cf;
            if (cf && cf.latitude && cf.longitude) {
                lat = Number(cf.latitude);
                lon = Number(cf.longitude);
                addressStr = [cf.city, cf.region, cf.country].filter(Boolean).join(", ");
                timezoneStr = (cf.timezone as string) || "UTC";
            } else {
                return errorResponse("Could not determine implicit location. Please provide a target.", 400);
            }
        } else {
            // Explicit Strategy
            const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(target) || /^[a-fA-F0-9:]+$/.test(target);
            
            if (isIp) {
                console.log(`[uniskill_geo] Explicit IP lookup: ${target}`);
                const res = await fetch(`http://ip-api.com/json/${target}`);
                const data: any = await res.json();
                if (data.status === "success") {
                    lat = Number(data.lat);
                    lon = Number(data.lon);
                    addressStr = `${data.city}, ${data.regionName}, ${data.country}`;
                    timezoneStr = data.timezone || "UTC";
                } else {
                    return errorResponse(`IP lookup failed: ${data.message}`, 400);
                }
            } else {
                console.log(`[uniskill_geo] Geocoding lookup: ${target}`);
                // Use OpenStreetMap Nominatim
                const encodedTarget = encodeURIComponent(target);
                const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodedTarget}&format=jsonv2&limit=1`, {
                    headers: { 'User-Agent': 'UniSkill-Gateway/1.0 (info@uniskill.ai)' }
                });
                const data: any = await res.json();
                
                if (data && data.length > 0) {
                    lat = Number(data[0].lat);
                    lon = Number(data[0].lon);
                    addressStr = data[0].display_name;
                    timezoneStr = "UTC"; 
                } else {
                    return errorResponse(`Geocoding failed: Could not find location for '${target}'`, 404);
                }
            }
        }

        if (lat === null || lon === null) {
            return errorResponse("Failed to resolve coordinates.", 500);
        }

        // ── 2. Build Static Map URL (if key present) ──
        let map_url = null;
        if (env.MAPBOX_API_KEY && env.MAPBOX_API_KEY !== "your_mapbox_api_key_here") {
            const zoom = target ? 13 : 9; // Zoom in more for specific places, out for IP regions
            map_url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${lon},${lat},${zoom},0/600x400?access_token=${env.MAPBOX_API_KEY}`;
        }

        // ── 3. Build Context Hints ──
        let localTimeStr = "";
        try {
            // Use Intl.DateTimeFormat to format time in the target timezone
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: timezoneStr,
                year: 'numeric',
                month: 'short',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                timeZoneName: 'short'
            });
            localTimeStr = formatter.format(new Date());
        } catch (e) {
            localTimeStr = new Date().toISOString() + " (UTC fallback)";
        }

        return successResponse({
            target_requested: target || "implicit",
            coordinates: { lat, lon },
            address: addressStr,
            timezone: timezoneStr,
            map_url: map_url,
            context_hints: {
                local_time: localTimeStr,
                is_weekend: new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: timezoneStr }).startsWith('S')
            }
        });

    } catch (e: any) {
        console.error(`[Geo Error]`, e);
        return errorResponse(e.message, 500);
    }
}
