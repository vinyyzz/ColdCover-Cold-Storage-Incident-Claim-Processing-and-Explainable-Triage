# Policy expansion demonstration

Use a disposable fictional workspace. The values exercise investigation rules.

## Stock cases

1. Open Inventory, add a fictional batch and choose the stock schedule below. Use a unique code, a fictional owner, 10 kg, ₹1,000 recorded value and entry **9 March 2026, 18:00 IST**, with no exit.
2. Open Policies and choose the matching case. Select the new batch. Choose **Paste case-specific temperature CSV** and paste the sample text. Select the reported event and add any evidence available in your exercise.
3. Preview the case, select an interval to inspect exact readings, and confirm the policy packet. Open the report or record a human review outcome.

| Sample | Policy and schedule | Expected qualified direction |
|---|---|---|
| fruit-banana.csv | Fruit Spoilage & Quality Loss. Bananas. | Below band |
| vegetables-leafy-greens.csv | Vegetable Spoilage. Leafy greens. | Below band |
| meat-frozen.csv | Chilled & Frozen Meat Spoilage. Frozen meat. | Above band |
| seafood-frozen.csv | Seafood Cold-Chain Spoilage. Frozen fish or prawns. | Above band |

The original potato example uses **Saved chamber readings** for 10 March 2026 and batches A, B and C. It produces ₹80,000 of inventory value under investigation. C arrived after the interval.

## Operator cases

- **Property Insurance.** Choose Fire and add a cold room such as `COLD-ROOM-1`. Add three texts under Asset or equipment declaration, Incident report or event records, and Facility damage inspection. Example facts are a fictional declaration listing the cold room, a report of fire and an inspection describing damaged panels.
- **Machinery Breakdown.** Choose Sudden electrical breakdown and add equipment `REF-01` with description Compressor motor. Add a declaration, breakdown report and technician repair estimate as separate texts. To exercise shared evidence, explicitly select a linked original incident whose report is relevant.

If only some records are available, the case shows **Needs more evidence**. A reviewer can still inspect a prepared packet and request additional information.
