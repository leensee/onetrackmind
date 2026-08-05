import 'dart:convert';
import 'dart:io';

import 'package:app/bench/walkthrough_script.dart';
import 'package:flutter_test/flutter_test.dart';

List<String> armOrder(WalkthroughSequence seq) => [
      for (final b in seq.blocks)
        if (b.steps.any((s) => s is ConfigureArmStep)) b.label,
    ];

int countOf<T>(WalkthroughSequence seq) => [
      for (final b in seq.blocks) ...b.steps,
    ].whereType<T>().length;

Map<String, dynamic> snapshotFixture({
  required String portType,
  String? active,
  String? preferred,
}) =>
    {
      'micMode': {'active': active, 'preferred': preferred ?? active},
      'route': {
        'inputs': [
          {'portType': portType, 'portName': 'fixture'},
        ],
      },
      'session': {'sampleRate': 48000.0},
    };

Map<String, dynamic> metadataFixture({
  required String arm,
  String? utteranceId,
  String? modeAtStart,
  String? modeAtStop,
  String portAtStop = 'MicrophoneBuiltIn',
}) =>
    {
      'arm_label': arm,
      'utterance_id': utteranceId,
      'micMode': {
        'atStart': {'active': modeAtStart},
        'atStop': {'active': modeAtStop},
      },
      'route': {
        'atStop': {
          'inputs': [
            {'portType': portAtStop, 'portName': 'fixture'},
          ],
        },
      },
    };

void main() {
  test('cleanroom sequence has arm order builtin-raw, builtin+vi, builtin-std',
      () {
    expect(armOrder(cleanroomSequence()),
        ['builtin-raw', 'builtin+vi', 'builtin-std']);
  });

  test('cleanroom sequence has 3 configure, 2 settle, 60 cards → 62 captures',
      () {
    final seq = cleanroomSequence();
    expect(countOf<ConfigureArmStep>(seq), 3);
    expect(countOf<SettleStep>(seq), 2);
    expect(countOf<CardStep>(seq), 60);
    expect(expectedCaptureCount(seq), 62);
  });

  test('field sequence follows protocol arm order with settle per VP arm', () {
    final seq = fieldSequence();
    expect(armOrder(seq), [
      'builtin-raw',
      'builtin+vi',
      'builtin-std',
      'ac-bt+vi',
      'ac-bt-std',
      'bc-bt+vi',
      'bc-bt-std',
      'builtin-earsplugged',
    ]);
    expect(countOf<ConfigureArmStep>(seq), 8);
    expect(countOf<SettleStep>(seq), 7); // every arm except builtin-raw
    expect(countOf<CardStep>(seq), 160);
    expect(expectedCaptureCount(seq), 167);
  });

  test('field sequence logs the retention notice as its first note step', () {
    final steps = [for (final b in fieldSequence().blocks) ...b.steps];
    final firstNote = steps
        .whereType<InstructionStep>()
        .firstWhere((s) => s.noteTemplate != null);
    expect(firstNote.body, contains('retained on the bench Mac'));
    expect(steps.indexOf(firstNote), 0);
  });

  test('within each arm block configure precedes settle precedes cards', () {
    for (final seq in [cleanroomSequence(), fieldSequence()]) {
      for (final block in seq.blocks) {
        final configureIx =
            block.steps.indexWhere((s) => s is ConfigureArmStep);
        if (configureIx < 0) continue;
        final settleIx = block.steps.indexWhere((s) => s is SettleStep);
        final firstCardIx = block.steps.indexWhere((s) => s is CardStep);
        expect(firstCardIx, greaterThan(configureIx),
            reason: '${seq.name}/${block.label}');
        if (settleIx >= 0) {
          expect(settleIx, greaterThan(configureIx));
          expect(firstCardIx, greaterThan(settleIx));
        }
      }
    }
  });

  test('every card phrase matches the utterance map', () {
    for (final seq in [cleanroomSequence(), fieldSequence()]) {
      for (final block in seq.blocks) {
        for (final s in block.steps.whereType<CardStep>()) {
          expect(s.phrase, utteranceTexts[s.utteranceId]);
        }
      }
    }
  });

  test('cutToU12 trims U13-U20 from blocks at and after the index only', () {
    final seq = fieldSequence();
    final blocksWithCards = [
      for (var i = 0; i < seq.blocks.length; i++)
        if (seq.blocks[i].steps.any((s) => s is CardStep)) i,
    ];
    final cutFrom = blocksWithCards[2];
    final cut = cutToU12(seq, cutFrom);
    for (var i = 0; i < cut.blocks.length; i++) {
      final cards = cut.blocks[i].steps.whereType<CardStep>().toList();
      if (cards.isEmpty) continue;
      expect(cards.length, i < cutFrom ? 20 : 12,
          reason: 'block $i (${cut.blocks[i].label})');
      if (i >= cutFrom) {
        expect(cards.every((c) => int.parse(c.utteranceId.substring(1)) <= 12),
            isTrue);
      }
    }
  });

  test('cutToU12 preserves block count and non-card steps', () {
    final seq = fieldSequence();
    final cut = cutToU12(seq, 0);
    expect(cut.blocks.length, seq.blocks.length);
    for (var i = 0; i < cut.blocks.length; i++) {
      expect(
          cut.blocks[i].steps.where((s) => s is! CardStep).length,
          seq.blocks[i].steps.where((s) => s is! CardStep).length);
    }
  });

  test('validateSnapshot passes matching route and mode', () {
    final r = validateSnapshot(
        arms['builtin+vi']!,
        snapshotFixture(
            portType: 'MicrophoneBuiltIn', active: 'voiceIsolation'),
        requireMode: true);
    expect(r.ok, isTrue);
  });

  test('validateSnapshot fails wrong route with a named problem', () {
    final r = validateSnapshot(arms['ac-bt+vi']!,
        snapshotFixture(portType: 'MicrophoneBuiltIn', active: 'voiceIsolation'),
        requireMode: true);
    expect(r.ok, isFalse);
    expect(r.problems.single, contains('BluetoothHFP'));
  });

  test('validateSnapshot ignores mode for builtin-raw', () {
    final r = validateSnapshot(arms['builtin-raw']!,
        snapshotFixture(portType: 'MicrophoneBuiltIn', active: 'standard'),
        requireMode: true);
    expect(r.ok, isTrue);
  });

  test('validateStopMetadata detects atStart/atStop mode drift', () {
    final drifted = validateStopMetadata(
        arms['builtin+vi']!,
        metadataFixture(
            arm: 'builtin+vi',
            utteranceId: 'U01',
            modeAtStart: 'voiceIsolation',
            modeAtStop: 'standard'),
        expectedUtteranceId: 'U01');
    expect(drifted.ok, isFalse);
    expect(drifted.problems.single, contains('at stop'));

    // Settling captures begin in the old mode by design.
    final settle = validateStopMetadata(
        arms['builtin+vi']!,
        metadataFixture(
            arm: 'builtin+vi',
            modeAtStart: 'standard',
            modeAtStop: 'voiceIsolation'),
        requireModeAtStart: false);
    expect(settle.ok, isTrue);
  });

  test('validateStopMetadata detects route drift and utterance mismatch', () {
    final r = validateStopMetadata(
        arms['builtin+vi']!,
        metadataFixture(
            arm: 'builtin+vi',
            utteranceId: 'U02',
            modeAtStart: 'voiceIsolation',
            modeAtStop: 'voiceIsolation',
            portAtStop: 'BluetoothHFP'),
        expectedUtteranceId: 'U01');
    expect(r.ok, isFalse);
    expect(r.problems, hasLength(2));
  });

  test('renderNote substitutes placeholders from the snapshot', () {
    final note = renderNote(
        'hfp-samplerate ac: sampleRate={sampleRate} route={route} op: {freeText}',
        snapshotFixture(portType: 'BluetoothHFP', active: 'voiceIsolation'),
        freeText: 'button ok');
    expect(note, contains('48000'));
    expect(note, contains('BluetoothHFP'));
    expect(note, contains('button ok'));
  });

  test('defaultSessionId formats <name>YYYYMMDD', () {
    expect(defaultSessionId('cleanroom', DateTime(2026, 7, 28)),
        'cleanroom20260728');
    expect(defaultSessionId('field', DateTime(2026, 1, 3)), 'field20260103');
  });

  test('utterance map matches tools/wer/references.json (authoritative)', () {
    final file = File('../tools/wer/references.json');
    expect(file.existsSync(), isTrue,
        reason: 'run from app/ inside the repo checkout');
    final json = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    final refs = (json['references'] as Map).cast<String, String>();
    expect(utteranceTexts, refs);
  });
}
