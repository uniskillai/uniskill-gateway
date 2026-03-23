import { SkillParser } from './src/engine/parser.ts';

const testInput = JSON.stringify({
    id: "test",
    config: {
        parameters: { q: { type: "string" } }
    },
    implementation: {
        type: "api",
        endpoint: "https://api.test.com"
    }
});

const spec = SkillParser.parse(testInput);
console.log("Implementation:", JSON.stringify(spec.implementation, null, 2));

if (!spec.implementation.endpoint) {
    console.error("FAIL: Endpoint missing!");
} else {
    console.log("SUCCESS: Endpoint found.");
}
