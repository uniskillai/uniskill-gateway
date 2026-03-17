import "dotenv/config";

async function testMCP() {
  const GATEWAY_URL = process.env.VITE_GATEWAY_URL || "https://uniskill-gateway.geekpro798.workers.dev";
  const API_KEY = process.env.VITE_TEST_USER_KEY || "us-test-dev-key"; // Ensure this key is valid

  console.log("1. Starting SSE connection...");
  const sseResponse = await fetch(`${GATEWAY_URL}/v1/mcp/sse`, {
    headers: { "Authorization": `Bearer ${API_KEY}` }
  });

  if (!sseResponse.ok) {
     console.error("SSE Failed", sseResponse.status);
     return;
  }

  const reader = sseResponse.body!.getReader();
  const decoder = new TextDecoder("utf-8");

  let sessionId = "";
  let postEndpoint = "";

  // Wait for the endpoint event
  while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      console.log("[SSE Raw]", chunk);

      if (chunk.includes("event: endpoint")) {
          const lines = chunk.split("\n");
          for (const line of lines) {
              if (line.startsWith("data: ")) {
                  postEndpoint = line.substring(6).trim();
                  sessionId = new URL(`http://localhost${postEndpoint}`).searchParams.get("sessionId") || "";
                  break;
              }
          }
      }
      if (postEndpoint) break;
  }

  if (!sessionId) {
      console.error("Failed to get sessionId");
      return;
  }

  console.log(`2. Got Session ID: ${sessionId}, Endpoint: ${postEndpoint}`);
  console.log("3. Sending tools/call message via POST...");

  const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
          name: "uniskill_smart_chart",
          arguments: {
              chartType: "bar",
              title: "MCP Test",
              labels: ["X", "Y"],
              datasets: [{ label: "Z", data: [10, 20] }]
          }
      }
  };

  const postResponse = await fetch(`${GATEWAY_URL}${postEndpoint}`, {
      method: "POST",
      headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify(payload)
  });

  console.log(`POST Status: ${postResponse.status}`);

  console.log("4. Waiting for SSE response...");
  
  // Read remaining SSE stream for the result
  while (true) {
      const { value, done } = await reader.read();
      if (done) {
          console.log("Stream closed");
          break;
      }
      const chunk = decoder.decode(value);
      console.log("[SSE Msg]", chunk);
      
      if (chunk.includes("jsonrpc") && chunk.includes("result")) {
          console.log("Got result, exiting.");
          break;
      }
  }
}

testMCP();
