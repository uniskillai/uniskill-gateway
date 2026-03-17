import "dotenv/config";

async function main() {
  console.log("Testing uniskill_smart_chart endpoint...");
  
  const API_KEY = process.env.VITE_TEST_USER_KEY || "us-test-dev-key"; // Replace with a valid key if needed
  const GATEWAY_URL = process.env.VITE_GATEWAY_URL || "https://uniskill-gateway.geekpro798.workers.dev";
  
  try {
    const response = await fetch(`${GATEWAY_URL}/v1/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        skill: "uniskill_smart_chart",
        params: {
          chartType: "bar",
          title: "Test Timeout",
          labels: ["A", "B"],
          datasets: [{ label: "Data", data: [1, 2] }]
        }
      })
    });
    
    console.log(`Status: ${response.status}`);
    const text = await response.text();
    console.log(`Body: ${text}`);
    
  } catch (err) {
    console.error("Test failed:", err);
  }
}

main();
