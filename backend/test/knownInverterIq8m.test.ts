// THE IQ8M IS 1.35 A, NOT THE IQ8 SERIES' 1.0 A (#544).
//
// The Human Review inverter card offers the looked-up total as a one-click "Confirm N A", and the PV
// breaker is sized from it (next standard size at or above 1.25 × the total). The built-in table's
// IQ8-series row matched "iq8m" too and gave the IQ8M 1.0 A: 10 units read 10 A and a 15 A breaker,
// where the IQ8M's 1.35 A gives 13.5 A and a 20 A breaker (the issue's own example: "IQ8M-72-2-US ×
// 10 → 13.5 A total"). The stub provider's lookup reads the same table first, offline, as the real
// one does (llm.ts lookupInverterSpec), so it is the path pinned here.
//
//   npx tsx backend/test/knownInverterIq8m.test.ts
import "./_isolate";

delete process.env.ANTHROPIC_API_KEY;
const { StubLLMProvider } = await import("../src/llm");
const llm = new StubLLMProvider();

let failures = 0;
let passed = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log(`  ok   - ${label}`); }
  else { failures++; console.error(`  FAIL - ${label}${detail ? `\n         ${detail}` : ""}`); }
};
const look = (inverterModel: string, inverterQty: number) => llm.lookupInverterSpec({ inverterModel, inverterQty });

const iq8m = await look("IQ8M-72-2-US", 10);
check("IQ8M-72-2-US: 1.35 A per unit, from the built-in table", iq8m.outputCurrentA === 1.35 && iq8m.source === "built-in equipment table", JSON.stringify(iq8m));
check("IQ8M-72-2-US × 10: 13.5 A total", iq8m.totalContinuousCurrentA === 13.5, JSON.stringify(iq8m));
check("IQ8M-72-2-US × 10: a 20 A PV breaker (1.25 × 13.5 = 16.9 A)", iq8m.derivedPvBreakerA === 20, JSON.stringify(iq8m));
check("the plan set's spelling 'Enphase IQ8M' reads the same row", (await look("Enphase IQ8M", 1)).outputCurrentA === 1.35);

// The rest of the series row is unchanged by this fix.
const iq8 = await look("IQ8-60-2-US", 10);
check("IQ8-60-2-US is still the series row: 1.0 A, 10 A total, 15 A breaker", iq8.outputCurrentA === 1 && iq8.totalContinuousCurrentA === 10 && iq8.derivedPvBreakerA === 15, JSON.stringify(iq8));
check("a bare 'IQ8' typed is the series row, not the IQ8M", (await look("IQ8", 1)).outputCurrentA === 1);
check("a Tesla part number still reads its own row", (await look("1538000-45-A", 1)).outputCurrentA === 31.7);

console.log(`\nknownInverterIq8m: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
