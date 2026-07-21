# Bench utterance cards — U01–U20

Scripted references for WER scoring. The machine-readable copy lives in `tools/wer/references.json` — **the two files must stay in sync**; the scorer treats references.json as authoritative.

**Speaker instructions:** speak each card once, naturally, at your normal working distance from the mic — don't lean in, don't over-enunciate. One capture per card, selected in the bench UI before you speak. If you flub a card, finish the capture anyway and just say so afterward; the scorer flags it — don't re-record over it. Machinery should be running for every field arm.

| ID | Reference text |
|----|----------------|
| U01 | Order two hydraulic filters for the spiker before Thursday |
| U02 | The tamper's left workhead is leaking and needs a seal kit |
| U03 | Remind me to torque the clamp bolts on the anchor machine at lunch |
| U04 | Log four hours on unit seventy three for the generator swap |
| U05 | Grab a box of five eighths spikes from the material truck |
| U06 | Tell the foreman the regulator threw a hose by the crossing |
| U07 | Schedule the five hundred hour service on the tie crane for Monday |
| U08 | The spiker gun on the left side is double firing again |
| U09 | Add a brake chamber for the tie handler to the parts list |
| U10 | Check the coolant level on unit forty one before we head out |
| U11 | The bone yard has a spare workhead, have the truck bring it up |
| U12 | Two ties skipped at the county road crossing, flag them for the tamper |
| U13 | We need diesel exhaust fluid for both tampers by Wednesday |
| U14 | The clip machine jammed twice this morning, the cylinder is dragging |
| U15 | Note that the spike puller blew a fitting near mile post two twelve |
| U16 | Swap the batteries on the rail drill and put it on charge |
| U17 | The kicker pads on the second spiker are worn to the metal |
| U18 | Call the dealer about the warranty claim on the new tamper screen |
| U19 | Pick up hydraulic oil, two drums, when you fuel the trucks |
| U20 | End of shift, machines tied down clear of the main at the siding |

Design notes: cards deliberately mix small numbers (unit numbers, quantities, mile posts — scored through the scorer's number normalization), MOW vocabulary (spiker, tamper, regulator, anchor machine, tie crane, clip machine, spike puller), and plain conversational structure. No personal names.
