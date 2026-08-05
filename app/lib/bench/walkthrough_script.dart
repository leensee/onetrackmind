// Walkthrough script — pure (deterministic) half. Step model, arm table,
// sequence builders, and validation predicates. No Flutter imports; the
// runner/UI lives in walkthrough_screen.dart (house pure/impure split).
//
// Arm expectations mirror docs/bench/protocol.md § Capture arms. Validation
// enforces the ground-truthing rule: the logged activeMicrophoneMode and
// route decide, never intent (findings.md Q5: pre-capture validation is
// mandatory for remote operation, not an enhancement).

/// One capture arm's expectations.
class ArmSpec {
  final String label;
  final String profile;

  /// Expected `micMode.active` during captures; null = no requirement (raw control).
  final String? expectedMode;

  /// Acceptable `route.inputs[].portType` values.
  final Set<String> expectedPortTypes;

  const ArmSpec({
    required this.label,
    required this.profile,
    required this.expectedMode,
    required this.expectedPortTypes,
  });

  bool get isBt => expectedPortTypes.contains('BluetoothHFP');
}

const Set<String> _builtin = {'MicrophoneBuiltIn'};
const Set<String> _bt = {'BluetoothHFP', 'BluetoothLE'};

const Map<String, ArmSpec> arms = {
  'builtin-raw': ArmSpec(
      label: 'builtin-raw',
      profile: 'raw',
      expectedMode: null,
      expectedPortTypes: _builtin),
  'builtin+vi': ArmSpec(
      label: 'builtin+vi',
      profile: 'vp-mode',
      expectedMode: 'voiceIsolation',
      expectedPortTypes: _builtin),
  'builtin-std': ArmSpec(
      label: 'builtin-std',
      profile: 'vp-mode',
      expectedMode: 'standard',
      expectedPortTypes: _builtin),
  'ac-bt+vi': ArmSpec(
      label: 'ac-bt+vi',
      profile: 'vp-mode',
      expectedMode: 'voiceIsolation',
      expectedPortTypes: _bt),
  'ac-bt-std': ArmSpec(
      label: 'ac-bt-std',
      profile: 'vp-mode',
      expectedMode: 'standard',
      expectedPortTypes: _bt),
  'bc-bt+vi': ArmSpec(
      label: 'bc-bt+vi',
      profile: 'vp-mode',
      expectedMode: 'voiceIsolation',
      expectedPortTypes: _bt),
  'bc-bt-std': ArmSpec(
      label: 'bc-bt-std',
      profile: 'vp-mode',
      expectedMode: 'standard',
      expectedPortTypes: _bt),
  'builtin-earsplugged': ArmSpec(
      label: 'builtin-earsplugged',
      profile: 'vp-mode',
      expectedMode: 'voiceIsolation',
      expectedPortTypes: _builtin),
};

/// Hardcoded copy of tools/wer/references.json. That file is authoritative;
/// app/test/walkthrough_script_test.dart asserts the two stay identical
/// (the sync rule from docs/bench/utterances.md, extended to this map).
const Map<String, String> utteranceTexts = {
  'U01': 'Order two hydraulic filters for the spiker before Thursday',
  'U02': "The tamper's left workhead is leaking and needs a seal kit",
  'U03': 'Remind me to torque the clamp bolts on the anchor machine at lunch',
  'U04': 'Log four hours on unit seventy three for the generator swap',
  'U05': 'Grab a box of five eighths spikes from the material truck',
  'U06': 'Tell the foreman the regulator threw a hose by the crossing',
  'U07': 'Schedule the five hundred hour service on the tie crane for Monday',
  'U08': 'The spiker gun on the left side is double firing again',
  'U09': 'Add a brake chamber for the tie handler to the parts list',
  'U10': 'Check the coolant level on unit forty one before we head out',
  'U11': 'The bone yard has a spare workhead, have the truck bring it up',
  'U12': 'Two ties skipped at the county road crossing, flag them for the tamper',
  'U13': 'We need diesel exhaust fluid for both tampers by Wednesday',
  'U14': 'The clip machine jammed twice this morning, the cylinder is dragging',
  'U15': 'Note that the spike puller blew a fitting near mile post two twelve',
  'U16': 'Swap the batteries on the rail drill and put it on charge',
  'U17': 'The kicker pads on the second spiker are worn to the metal',
  'U18': 'Call the dealer about the warranty claim on the new tamper screen',
  'U19': 'Pick up hydraulic oil, two drums, when you fuel the trucks',
  'U20': 'End of shift, machines tied down clear of the main at the siding',
};

sealed class WalkthroughStep {
  final String id;
  const WalkthroughStep(this.id);
}

/// Text the operator reads and acknowledges. When [noteTemplate] is set, the
/// acknowledgment is logged to the receiver as a text note (placeholders
/// substituted by [renderNote] at ack time).
class InstructionStep extends WalkthroughStep {
  final String title;
  final String body;
  final String? noteTemplate;
  final bool allowsFreeText;
  const InstructionStep(super.id,
      {required this.title,
      required this.body,
      this.noteTemplate,
      this.allowsFreeText = false});
}

/// Apply the arm's session profile and wait for the route to match.
/// Re-applying the same profile is the documented BT route-claim workaround
/// (deactivate → configure → activate; findings.md Q2 operational note).
class ConfigureArmStep extends WalkthroughStep {
  final ArmSpec arm;
  const ConfigureArmStep(super.id, {required this.arm});
}

/// Set the mic mode via the system sheet during a live settling capture.
/// The sheet is blank when idle (Q1), so the capture must start first.
class SettleStep extends WalkthroughStep {
  final ArmSpec arm;
  const SettleStep(super.id, {required this.arm});
}

/// One scripted utterance capture.
class CardStep extends WalkthroughStep {
  final ArmSpec arm;
  final String utteranceId;
  final String phrase;
  const CardStep(super.id,
      {required this.arm, required this.utteranceId, required this.phrase});
}

/// The resume unit: one arm (or an instruction-only group).
class WalkthroughBlock {
  final String label;
  final List<WalkthroughStep> steps;
  const WalkthroughBlock({required this.label, required this.steps});
}

class WalkthroughSequence {
  final String name; // 'cleanroom' | 'field'
  final List<WalkthroughBlock> blocks;
  const WalkthroughSequence({required this.name, required this.blocks});
}

const String speakerInstructions =
    'Speak each card once, naturally, at your normal working distance from '
    'the mic — don\'t lean in, don\'t over-enunciate. One capture per card. '
    'If you flub a card, finish the capture anyway and move on — the scorer '
    'flags it. Never re-record over a flub.\n\n'
    'Keep the app in the foreground for the whole session, and consider '
    'disabling auto-lock (Settings > Display & Brightness > Auto-Lock) '
    'until you\'re done.';

/// §10 bench-exception condition: the field user is told, before recording,
/// that audio is retained and that other voices will be captured incidentally.
/// Wording tracks docs/bench/protocol.md § Field session runbook.
const String retentionNotice =
    'Audio from this session is retained on the bench Mac for '
    'transcription-accuracy analysis and deleted once the four spike '
    'questions are answered and recorded. Other workers\' voices will '
    'likely be captured incidentally beside running equipment.';

List<CardStep> _cards(String seq, ArmSpec arm) {
  return [
    for (final id in utteranceTexts.keys)
      CardStep('$seq/${arm.label}/$id',
          arm: arm, utteranceId: id, phrase: utteranceTexts[id]!),
  ];
}

WalkthroughBlock _armBlock(String seq, ArmSpec arm,
    {List<WalkthroughStep> before = const [],
    List<WalkthroughStep> after = const []}) {
  return WalkthroughBlock(label: arm.label, steps: [
    ...before,
    ConfigureArmStep('$seq/${arm.label}/configure', arm: arm),
    if (arm.expectedMode != null) SettleStep('$seq/${arm.label}/settle', arm: arm),
    ..._cards(seq, arm),
    ...after,
  ]);
}

WalkthroughSequence cleanroomSequence() {
  const seq = 'cleanroom';
  return WalkthroughSequence(name: seq, blocks: [
    const WalkthroughBlock(label: 'intro', steps: [
      InstructionStep('$seq/intro',
          title: 'Clean-room pass',
          body: 'Quiet room, phone handheld at natural distance. Three arms, '
              '20 cards each, plus a mode-settling capture before the two '
              'voice-processing arms.\n\n$speakerInstructions'),
    ]),
    _armBlock(seq, arms['builtin-raw']!),
    _armBlock(seq, arms['builtin+vi']!),
    _armBlock(seq, arms['builtin-std']!),
  ]);
}

WalkthroughSequence fieldSequence() {
  const seq = 'field';
  return WalkthroughSequence(name: seq, blocks: [
    const WalkthroughBlock(label: 'intro', steps: [
      InstructionStep('$seq/retention',
          title: 'Before recording — please read',
          body: retentionNotice,
          noteTemplate: 'retention-notice acknowledged (field walkthrough)'),
      InstructionStep('$seq/speaker',
          title: 'How to record',
          body: 'Machinery should be running for every arm.\n\n'
              '$speakerInstructions'),
    ]),
    _armBlock(seq, arms['builtin-raw']!),
    _armBlock(seq, arms['builtin+vi']!),
    _armBlock(seq, arms['builtin-std']!),
    _armBlock(seq, arms['ac-bt+vi']!, before: const [
      InstructionStep('$seq/ac-connect',
          title: 'Connect the AC headset',
          body: 'Pair/connect the air-conduction headset now. The next step '
              're-applies the audio profile so the headset claims the input '
              'route — if the route won\'t stick, toggle the headset '
              'connection and tap Re-apply.'),
    ], after: const [
      InstructionStep('$seq/ac-hfp-rate',
          title: 'Headset sample rate check',
          body: 'Acknowledging logs the negotiated input sample rate for this '
              'headset (8 kHz = CVSD, 16 kHz = mSBC, 24/32 kHz = LE Audio).',
          noteTemplate: 'hfp-samplerate ac: sampleRate={sampleRate} route={route}'),
    ]),
    _armBlock(seq, arms['ac-bt-std']!, after: const [
      InstructionStep('$seq/ac-glove',
          title: 'Glove check — AC headset',
          body: 'With work gloves on, operate this headset\'s controls '
              '(button / tap). Note pass or fail per control.',
          noteTemplate: 'glove-check ac: {freeText}',
          allowsFreeText: true),
    ]),
    _armBlock(seq, arms['bc-bt+vi']!, before: const [
      InstructionStep('$seq/bc-connect',
          title: 'Connect the BC headset',
          body: 'Disconnect the AC headset, connect the bone-conduction '
              'headset. Same drill: the next step re-applies the profile so '
              'it claims the route.'),
    ], after: const [
      InstructionStep('$seq/bc-hfp-rate',
          title: 'Headset sample rate check',
          body: 'Acknowledging logs the negotiated input sample rate for this '
              'headset.',
          noteTemplate: 'hfp-samplerate bc: sampleRate={sampleRate} route={route}'),
    ]),
    _armBlock(seq, arms['bc-bt-std']!, after: const [
      InstructionStep('$seq/bc-glove',
          title: 'Glove check — BC headset',
          body: 'With work gloves on, operate this headset\'s controls. '
              'Note pass or fail per control.',
          noteTemplate: 'glove-check bc: {freeText}',
          allowsFreeText: true),
    ]),
    _armBlock(seq, arms['builtin-earsplugged']!, before: const [
      InstructionStep('$seq/earplugged-setup',
          title: 'Ear plugs in, headset off',
          body: 'Disconnect the BT headset entirely and confirm the route '
              'returns to the built-in mic on the next step. Insert ear plugs '
              'before recording.'),
    ]),
    const WalkthroughBlock(label: 'persistence-1', steps: [
      InstructionStep('$seq/persistence-1',
          title: 'Persistence check — part 1',
          body: 'Note the preferred mic mode shown above, then force-quit '
              'this app (swipe it away), relaunch it, reopen the Field '
              'walkthrough, and tap Resume.',
          noteTemplate: 'persistence-check initiated; preferred={preferredMode}'),
    ]),
    const WalkthroughBlock(label: 'persistence-2', steps: [
      InstructionStep('$seq/persistence-2',
          title: 'Persistence check — part 2',
          body: 'You relaunched after a force-quit. Does the preferred mic '
              'mode shown above match what you noted before? Type yes/no and '
              'anything odd.',
          noteTemplate:
              'persistence-check result: preferred={preferredMode}; operator: {freeText}',
          allowsFreeText: true),
    ]),
  ]);
}

/// Time-box rule (protocol.md): cut to U01–U12 for blocks at and after
/// [fromBlockIndex]; never removes blocks — arms are never cut.
WalkthroughSequence cutToU12(WalkthroughSequence seq, int fromBlockIndex) {
  bool keep(WalkthroughStep s) {
    if (s is! CardStep) return true;
    final n = int.tryParse(s.utteranceId.substring(1)) ?? 0;
    return n <= 12;
  }

  return WalkthroughSequence(name: seq.name, blocks: [
    for (var i = 0; i < seq.blocks.length; i++)
      i < fromBlockIndex
          ? seq.blocks[i]
          : WalkthroughBlock(
              label: seq.blocks[i].label,
              steps: seq.blocks[i].steps.where(keep).toList()),
  ]);
}

class ValidationResult {
  final bool ok;
  final List<String> problems;
  const ValidationResult(this.ok, this.problems);
  static const pass = ValidationResult(true, []);
}

List<Map<String, dynamic>> _inputs(Map<String, dynamic>? route) {
  final inputs = route?['inputs'];
  if (inputs is! List) return const [];
  return [for (final i in inputs) (i as Map).cast<String, dynamic>()];
}

bool _routeMatches(ArmSpec arm, Map<String, dynamic>? route) {
  return _inputs(route)
      .any((i) => arm.expectedPortTypes.contains(i['portType'] as String?));
}

String _describeInputs(Map<String, dynamic>? route) {
  final inputs = _inputs(route);
  if (inputs.isEmpty) return 'no active inputs';
  return inputs.map((i) => '${i['portType']} (${i['portName']})').join(', ');
}

/// Gate for the live snapshot: route always, mode only when [requireMode]
/// (idle mode reads are advisory; stop metadata is the authority).
ValidationResult validateSnapshot(ArmSpec arm, Map<String, dynamic> snapshot,
    {required bool requireMode}) {
  final problems = <String>[];
  final route = (snapshot['route'] as Map?)?.cast<String, dynamic>();
  if (!_routeMatches(arm, route)) {
    problems.add('route is ${_describeInputs(route)} — expected '
        '${arm.expectedPortTypes.join(' or ')}');
  }
  if (requireMode && arm.expectedMode != null) {
    final active = (snapshot['micMode'] as Map?)?['active'];
    if (active != arm.expectedMode) {
      problems.add('mic mode is $active — expected ${arm.expectedMode}');
    }
  }
  return problems.isEmpty ? ValidationResult.pass : ValidationResult(false, problems);
}

/// The authoritative post-capture check, against stopCapture's metadata.
/// [requireModeAtStart] is false for settling captures — they begin in the
/// old mode by design and only the end state matters.
ValidationResult validateStopMetadata(ArmSpec arm, Map<String, dynamic> metadata,
    {String? expectedUtteranceId, bool requireModeAtStart = true}) {
  final problems = <String>[];
  final micMode = (metadata['micMode'] as Map?)?.cast<String, dynamic>();
  if (arm.expectedMode != null) {
    final atStart = (micMode?['atStart'] as Map?)?['active'];
    final atStop = (micMode?['atStop'] as Map?)?['active'];
    if (requireModeAtStart && atStart != arm.expectedMode) {
      problems.add('mode at start was $atStart — expected ${arm.expectedMode}');
    }
    if (atStop != arm.expectedMode) {
      problems.add('mode at stop was $atStop — expected ${arm.expectedMode}');
    }
  }
  final routeAtStop =
      ((metadata['route'] as Map?)?['atStop'] as Map?)?.cast<String, dynamic>();
  if (!_routeMatches(arm, routeAtStop)) {
    problems.add('route at stop was ${_describeInputs(routeAtStop)} — expected '
        '${arm.expectedPortTypes.join(' or ')}');
  }
  if (metadata['arm_label'] != arm.label) {
    problems.add('arm label logged as ${metadata['arm_label']} — expected ${arm.label}');
  }
  if (expectedUtteranceId != null &&
      metadata['utterance_id'] != expectedUtteranceId) {
    problems.add('utterance logged as ${metadata['utterance_id']} — expected '
        '$expectedUtteranceId');
  }
  return problems.isEmpty ? ValidationResult.pass : ValidationResult(false, problems);
}

/// Substitute {placeholders} in a note template from the live snapshot.
String renderNote(String template, Map<String, dynamic> snapshot,
    {String freeText = ''}) {
  final micMode = (snapshot['micMode'] as Map?)?.cast<String, dynamic>();
  final session = (snapshot['session'] as Map?)?.cast<String, dynamic>();
  final route = (snapshot['route'] as Map?)?.cast<String, dynamic>();
  return template
      .replaceAll('{preferredMode}', '${micMode?['preferred']}')
      .replaceAll('{activeMode}', '${micMode?['active']}')
      .replaceAll('{sampleRate}', '${session?['sampleRate']}')
      .replaceAll('{route}', _describeInputs(route))
      .replaceAll('{freeText}', freeText);
}

String defaultSessionId(String sequenceName, DateTime now) {
  final y = now.year.toString().padLeft(4, '0');
  final m = now.month.toString().padLeft(2, '0');
  final d = now.day.toString().padLeft(2, '0');
  return '$sequenceName$y$m$d';
}

/// Captures a full run should produce (cards + settling captures).
int expectedCaptureCount(WalkthroughSequence seq) {
  var n = 0;
  for (final b in seq.blocks) {
    for (final s in b.steps) {
      if (s is CardStep || s is SettleStep) n++;
    }
  }
  return n;
}
