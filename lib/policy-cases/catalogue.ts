export const policyIds = ["fruit", "vegetables", "meat", "seafood", "property", "machinery"] as const;
export type PolicyId = typeof policyIds[number];
export const evidenceLabels = {
  breakdown: "Refrigeration or equipment breakdown report",
  inspection: "Stock inspection or qualified condition assessment",
  inventory: "Stock quantities and recorded values",
  grade: "Grading and recorded value evidence",
  atmosphere: "Oxygen and CO₂ records",
  humidity: "Humidity and control records",
  laboratory: "Laboratory report and testing cost documentation",
  transit: "Refrigerated transit and custody records",
  declaration: "Asset or equipment declaration",
  event: "Incident report or event records",
  damage: "Facility damage inspection or photographs described in a report",
  repair: "Repair or replacement documentation",
} as const;
export type EvidenceKind = keyof typeof evidenceLabels;
type Policy = { name: string; group: "goods" | "operator"; wording: string; example: string; required: readonly EvidenceKind[]; triggers: readonly string[] };
const goodsTriggers = ["Mechanical or electrical refrigeration failure", "Refrigerant leakage", "Thermostat or controller failure"] as const;
const goodsEvidence = ["breakdown", "inspection", "inventory"] as const;
export const catalogue: Record<PolicyId, Policy> = {
  fruit: { name: "Fruit Spoilage & Quality Loss", group: "goods", wording: "Review reported premature ripening, chilling injury or accidental freezing after a specified refrigeration failure. Grading evidence can support a reported quality downgrade.", example: "A failed thermostat exposes bananas to unusually low temperatures.", required: goodsEvidence, triggers: goodsTriggers },
  vegetables: { name: "Vegetable Spoilage", group: "goods", wording: "Review reported wilting, freezing damage or accelerated rot after a specified refrigeration failure. Select the schedule for the commodity and storage state.", example: "A faulty controller exposes leafy greens to unusually low temperatures.", required: goodsEvidence, triggers: goodsTriggers },
  meat: { name: "Chilled & Frozen Meat Spoilage", group: "goods", wording: "Review recorded warming in chilled stock or thawing in frozen stock after a specified refrigeration failure. Preserve any qualified lot assessment.", example: "A compressor failure warms frozen chicken.", required: goodsEvidence, triggers: goodsTriggers },
  seafood: { name: "Seafood Cold-Chain Spoilage", group: "goods", wording: "Review temperature excursions following a specified refrigeration failure affecting fresh, iced or frozen seafood. Preserve qualified test results where supplied.", example: "Frozen seafood warms after a compressor fails.", required: goodsEvidence, triggers: goodsTriggers },
  property: { name: "Property Insurance", group: "operator", wording: "Review physical damage to declared facility assets after a specified event, including buildings, cold rooms, insulation panels and electrical installations.", example: "A fire damages two cold rooms and their electrical installations.", required: ["declaration", "event", "damage"], triggers: ["Fire", "Flood", "Storm"] },
  machinery: { name: "Machinery Breakdown", group: "operator", wording: "Review repair or replacement evidence for declared insured equipment following sudden mechanical or electrical breakdown.", example: "A compressor motor burns out.", required: ["declaration", "breakdown", "repair"], triggers: ["Sudden mechanical breakdown", "Sudden electrical breakdown"] },
};

export const scheduleIds = ["banana", "apple", "leafy-greens", "potato", "frozen-vegetables", "chilled-meat", "frozen-meat", "fresh-iced-seafood", "frozen-seafood"] as const;
export type ScheduleId = typeof scheduleIds[number];
type Schedule = { policyId: PolicyId; name: string; minC: number; maxC: number; minMinutes: number; maxGapMinutes: number };
export const schedules: Record<ScheduleId, Schedule> = {
  banana: { policyId: "fruit", name: "Bananas · chilled produce", minC: 13, maxC: 15, minMinutes: 30, maxGapMinutes: 30 },
  apple: { policyId: "fruit", name: "Apples · cold storage", minC: 0, maxC: 4, minMinutes: 30, maxGapMinutes: 30 },
  "leafy-greens": { policyId: "vegetables", name: "Leafy greens · chilled", minC: 0, maxC: 3, minMinutes: 20, maxGapMinutes: 20 },
  potato: { policyId: "vegetables", name: "Potatoes · roots and tubers", minC: 2, maxC: 5, minMinutes: 30, maxGapMinutes: 30 },
  "frozen-vegetables": { policyId: "vegetables", name: "Frozen vegetables", minC: -25, maxC: -18, minMinutes: 30, maxGapMinutes: 30 },
  "chilled-meat": { policyId: "meat", name: "Chilled meat", minC: 0, maxC: 4, minMinutes: 20, maxGapMinutes: 20 },
  "frozen-meat": { policyId: "meat", name: "Frozen meat", minC: -26, maxC: -18, minMinutes: 30, maxGapMinutes: 30 },
  "fresh-iced-seafood": { policyId: "seafood", name: "Fresh or iced seafood", minC: 0, maxC: 2, minMinutes: 20, maxGapMinutes: 20 },
  "frozen-seafood": { policyId: "seafood", name: "Frozen fish or prawns", minC: -28, maxC: -18, minMinutes: 20, maxGapMinutes: 20 },
};

export const extensionIds = ["grade", "atmosphere", "humidity", "laboratory", "transit"] as const;
export const extensions: Record<typeof extensionIds[number], { name: string; policyId: PolicyId; schedule?: ScheduleId }> = {
  grade: { name: "Fruit quality downgrade", policyId: "fruit" },
  atmosphere: { name: "Controlled atmosphere for apples", policyId: "fruit", schedule: "apple" },
  humidity: { name: "Vegetable humidity control", policyId: "vegetables", schedule: "leafy-greens" },
  laboratory: { name: "Seafood testing, including histamine where relevant", policyId: "seafood" },
  transit: { name: "Refrigerated transit", policyId: "seafood" },
};
export const scheduleLabel = (id: ScheduleId) => {
  const s = schedules[id];
  return `${s.name} · ${s.minC} to ${s.maxC} °C`;
};
export const demoScheduleNotice = "Fictional investigation thresholds. Follow the commodity's actual storage specification in practice.";
