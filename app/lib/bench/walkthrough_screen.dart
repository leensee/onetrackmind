import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'capture_channel.dart';
import 'capture_queue.dart';
import 'models.dart';
import 'submit_client.dart';
import 'walkthrough_script.dart';

/// Guided per-arm capture walkthrough. Sequencing, gating, and validation
/// come from walkthrough_script.dart (pure); this screen owns the runner
/// state machine and all platform I/O. Foreground-only by design — the
/// queue's drain loop keeps syncing underneath; capture success never
/// blocks on receiver reachability.
class WalkthroughScreen extends StatefulWidget {
  final CaptureChannel channel;
  final CaptureQueue queue;
  final SubmitClient client;
  final BenchSettings Function() settings;
  final Future<void> Function(BenchSettings) saveSettings;
  final WalkthroughSequence sequence;
  final File progressFile;

  const WalkthroughScreen({
    super.key,
    required this.channel,
    required this.queue,
    required this.client,
    required this.settings,
    required this.saveSettings,
    required this.sequence,
    required this.progressFile,
  });

  @override
  State<WalkthroughScreen> createState() => _WalkthroughScreenState();
}

enum _Phase { setup, running, complete }

enum _CaptureStatus { idle, capturing, stopping }

class _WalkthroughScreenState extends State<WalkthroughScreen>
    with WidgetsBindingObserver {
  static const _progressSchema = 'otm-walkthrough-progress.v1';

  _Phase _phase = _Phase.setup;
  late WalkthroughSequence _sequence = widget.sequence;
  int _blockIx = 0;
  int _stepIx = 0;
  int _skipCardsBefore = 0; // resume: skip cards below this index in _blockIx
  int? _cutFromBlock;
  SettleStep? _injectedSettle; // transient re-settle before a blocked card

  _CaptureStatus _capture = _CaptureStatus.idle;
  bool _configureDone = false;
  bool _interrupted = false;
  List<String> _problems = [];
  DateTime? _recStart;

  Map<String, dynamic> _snapshot = {};
  Timer? _tick;
  StreamSubscription<Map<String, dynamic>>? _events;

  final Map<String, int> _tally = {};
  ({int pending, int parked, int synced}) _queueSummary =
      (pending: 0, parked: 0, synced: 0);
  List<CaptureEntry> _sessionEntries = [];

  late final TextEditingController _sessionIdCtl;
  final _freeTextCtl = TextEditingController();
  bool? _pingOk;
  bool _pinging = false;

  WalkthroughStep get _step =>
      _injectedSettle ?? _sequence.blocks[_blockIx].steps[_stepIx];
  WalkthroughBlock get _block => _sequence.blocks[_blockIx];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final existing = widget.settings().sessionId;
    _sessionIdCtl = TextEditingController(
        text: existing.startsWith(widget.sequence.name)
            ? existing
            : defaultSessionId(widget.sequence.name, DateTime.now()));
    _events = widget.channel.events.listen(_onEvent);
    _ping();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _tick?.cancel();
    _events?.cancel();
    _sessionIdCtl.dispose();
    _freeTextCtl.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _phase == _Phase.running) {
      _refreshSnapshot().then((_) {
        if (_capture == _CaptureStatus.capturing &&
            _snapshot['capturing'] == false) {
          _handleUnsolicitedStop();
        }
      });
    }
  }

  // ── setup ──────────────────────────────────────────────────

  Future<void> _ping() async {
    setState(() => _pinging = true);
    final ok = await widget.client.ping(widget.settings().receiverUrl);
    if (!mounted) return;
    setState(() {
      _pingOk = ok;
      _pinging = false;
    });
  }

  Future<void> _start() async {
    final s = widget.settings();
    await widget.saveSettings(BenchSettings(
        receiverUrl: s.receiverUrl,
        secret: s.secret,
        sessionId: _sessionIdCtl.text.trim()));

    if (!mounted) return;
    final saved = _readProgress();
    if (saved != null &&
        saved['sequence'] == widget.sequence.name &&
        saved['session_id'] == _sessionIdCtl.text.trim()) {
      final resume = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Resume?'),
          content: Text('A previous run of this walkthrough stopped partway '
              '(block ${(saved['block_index'] as num) + 1}). Resume there, '
              'or start over?'),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text('Start over')),
            FilledButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text('Resume')),
          ],
        ),
      );
      if (resume == true) {
        if (saved['cut_from_block'] != null) {
          _cutFromBlock = (saved['cut_from_block'] as num).toInt();
          _sequence = cutToU12(_sequence, _cutFromBlock!);
        }
        _blockIx = (saved['block_index'] as num).toInt();
        _stepIx = 0;
        _skipCardsBefore = (saved['step_index'] as num).toInt();
      } else {
        _deleteProgress();
      }
    }
    setState(() => _phase = _Phase.running);
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => _onTick());
    await _refreshSnapshot();
    _enterStep();
  }

  // ── progress persistence ───────────────────────────────────

  Map<String, dynamic>? _readProgress() {
    try {
      if (!widget.progressFile.existsSync()) return null;
      final json = jsonDecode(widget.progressFile.readAsStringSync());
      if (json is! Map || json['schema'] != _progressSchema) return null;
      return json.cast<String, dynamic>();
    } on FormatException {
      return null;
    }
  }

  void _persistProgress({required int nextStepIx}) {
    widget.progressFile.writeAsStringSync(jsonEncode({
      'schema': _progressSchema,
      'sequence': _sequence.name,
      'session_id': widget.settings().sessionId,
      'block_index': _blockIx,
      'step_index': nextStepIx,
      'cut_from_block': _cutFromBlock,
      'updated_at': DateTime.now().toUtc().toIso8601String(),
    }));
  }

  void _deleteProgress() {
    if (widget.progressFile.existsSync()) widget.progressFile.deleteSync();
  }

  // ── runner core ────────────────────────────────────────────

  Future<void> _refreshSnapshot() async {
    try {
      final snap = await widget.channel.getSnapshot();
      if (mounted) setState(() => _snapshot = snap);
    } on PlatformException {
      // transient; next tick retries
    }
  }

  void _onTick() {
    _refreshSnapshot();
  }

  void _onEvent(Map<String, dynamic> event) {
    if (_phase != _Phase.running) return;
    switch (event['type']) {
      case 'micModeChanged':
      case 'routeChange':
        _refreshSnapshot();
      case 'interruption':
        _interrupted = true;
      case 'captureStopped':
        if (_capture == _CaptureStatus.capturing) _handleUnsolicitedStop();
    }
  }

  void _enterStep() {
    _problems = [];
    _interrupted = false;
    _configureDone = false;
    _capture = _CaptureStatus.idle;
    _freeTextCtl.clear();
    setState(() {});
    final step = _step;
    if (step is ConfigureArmStep) _runConfigure(step);
    if (step is SettleStep) _startSettle(step);
  }

  void _advance() {
    if (_injectedSettle != null) {
      // Re-settle finished; return to the card that was blocked.
      _injectedSettle = null;
      _enterStep();
      return;
    }
    _stepIx++;
    while (true) {
      if (_stepIx >= _block.steps.length) {
        _blockIx++;
        _stepIx = 0;
        _skipCardsBefore = 0;
        if (_blockIx >= _sequence.blocks.length) {
          _complete();
          return;
        }
        _persistProgress(nextStepIx: 0);
        continue;
      }
      final s = _block.steps[_stepIx];
      if (s is CardStep && _stepIx < _skipCardsBefore) {
        _stepIx++;
        continue;
      }
      break;
    }
    _enterStep();
  }

  void _fail(List<String> problems) {
    if (!mounted) return;
    setState(() {
      _capture = _CaptureStatus.idle;
      _problems = problems;
    });
  }

  Future<void> _complete() async {
    _tick?.cancel();
    final entries = await widget.queue.listEntries();
    final session = widget.settings().sessionId;
    final mine = entries.where((e) => e.sessionId == session).toList();
    final summary = await widget.queue.summary();
    _deleteProgress();
    if (!mounted) return;
    setState(() {
      _sessionEntries = mine;
      _queueSummary = summary;
      _phase = _Phase.complete;
    });
  }

  // ── configure ──────────────────────────────────────────────

  Future<void> _runConfigure(ConfigureArmStep step) async {
    try {
      await widget.channel.configureSession(step.arm.profile);
      await widget.channel
          .setDefaults(profile: step.arm.profile, armLabel: step.arm.label);
      _configureDone = true;
      await _refreshSnapshot(); // configureSession's return lacks keys; re-read
      if (mounted) setState(() {});
    } on PlatformException catch (e) {
      if (e.code == 'alreadyCapturing') {
        // A crashed step left a capture running; clear it and retry once.
        try {
          await widget.channel.stopCapture();
        } on PlatformException {
          // fall through to the failure banner
        }
        try {
          await widget.channel.configureSession(step.arm.profile);
          _configureDone = true;
          await _refreshSnapshot();
          if (mounted) setState(() {});
          return;
        } on PlatformException catch (e2) {
          _fail(['configure failed: ${e2.code} ${e2.message}']);
          return;
        }
      }
      _fail(['configure failed: ${e.code} ${e.message}']);
    }
  }

  // ── settle ─────────────────────────────────────────────────

  Future<void> _startSettle(SettleStep step) async {
    setState(() {
      _capture = _CaptureStatus.capturing;
      _problems = [];
      _interrupted = false;
      _recStart = DateTime.now();
    });
    try {
      await widget.channel.startCapture(
          triggerSource: 'walkthrough-settle',
          armLabel: step.arm.label,
          utteranceId: null);
      // Sheet only renders during a live capture (Q1); dismissal is
      // undetectable, so the gate is the observed active mode, never the sheet.
      await widget.channel.showMicModeUI();
    } on PlatformException catch (e) {
      _fail(['settle start failed: ${e.code} ${e.message}']);
    }
  }

  Future<void> _finishSettle(SettleStep step) async {
    setState(() => _capture = _CaptureStatus.stopping);
    try {
      final result = await widget.channel.stopCapture();
      await _enqueueStop(result);
      final metadata =
          (result['captureMetadata'] as Map?)?.cast<String, dynamic>() ?? {};
      final v = validateStopMetadata(step.arm, metadata,
          requireModeAtStart: false);
      if (v.ok) {
        _bumpTally(step.arm.label);
        _advance();
      } else {
        _fail([...v.problems, 'redo the settling capture']);
      }
    } on PlatformException catch (e) {
      _fail(['settle stop failed: ${e.code} ${e.message}']);
    }
  }

  // ── cards ──────────────────────────────────────────────────

  Future<void> _startCard(CardStep step) async {
    setState(() {
      _capture = _CaptureStatus.capturing;
      _problems = [];
      _interrupted = false;
      _recStart = DateTime.now();
    });
    try {
      await widget.channel.startCapture(
          triggerSource: 'walkthrough',
          armLabel: step.arm.label,
          utteranceId: step.utteranceId);
    } on PlatformException catch (e) {
      _fail(['record failed: ${e.code} ${e.message}']);
    }
  }

  Future<void> _stopCard(CardStep step) async {
    setState(() => _capture = _CaptureStatus.stopping);
    try {
      final result = await widget.channel.stopCapture();
      // Enqueue regardless of validity — the log is authoritative and
      // analysis discards mislabeled captures (protocol ground-truthing).
      await _enqueueStop(result);
      final metadata =
          (result['captureMetadata'] as Map?)?.cast<String, dynamic>() ?? {};
      final v = validateStopMetadata(step.arm, metadata,
          expectedUtteranceId: step.utteranceId);
      if (v.ok) {
        _bumpTally(step.arm.label);
        _persistProgress(nextStepIx: _injectedSettle == null ? _stepIx + 1 : _stepIx);
        final secs =
            ((result['durationMs'] as num? ?? 0) / 1000).toStringAsFixed(1);
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text('${step.utteranceId} captured (${secs}s)'),
              duration: const Duration(seconds: 1)));
        }
        _advance();
      } else {
        _fail([...v.problems, 'capture kept for the log — redo this card']);
      }
    } on PlatformException catch (e) {
      _fail(['stop failed: ${e.code} ${e.message}']);
    }
  }

  Future<void> _handleUnsolicitedStop() async {
    _capture = _CaptureStatus.stopping;
    try {
      final result = await widget.channel.stopCapture();
      await _enqueueStop(result);
    } on PlatformException {
      // Swift already tore the capture down; nothing to enqueue.
    }
    _fail([
      _interrupted
          ? 'capture interrupted by the system (call/route)'
          : 'capture ended by the system',
      'redo this step',
    ]);
  }

  Future<void> _enqueueStop(Map<String, dynamic> stopResult) async {
    await widget.queue.enqueueAudio(
        stopResult: stopResult, sessionId: widget.settings().sessionId);
    final summary = await widget.queue.summary();
    if (mounted) setState(() => _queueSummary = summary);
  }

  void _bumpTally(String arm) {
    _tally[arm] = (_tally[arm] ?? 0) + 1;
  }

  // ── instructions / notes ───────────────────────────────────

  Future<void> _acknowledge(InstructionStep step) async {
    if (step.noteTemplate != null) {
      await widget.queue.enqueueText(
          text: renderNote(step.noteTemplate!, _snapshot,
              freeText: _freeTextCtl.text.trim()),
          sessionId: widget.settings().sessionId,
          deviceProvenance: const {'source': 'walkthrough'});
    }
    _advance();
  }

  // ── cut to U12 ─────────────────────────────────────────────

  Future<void> _cutToU12() async {
    // Monotonic: a cut can only be requested later in the sequence than an
    // existing one, and resume reapplies solely from the saved index — so a
    // repeat would silently regress the earlier cut. Ignore repeats.
    if (_cutFromBlock != null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Cut already applied — remaining arms are at U01–U12.'),
          duration: Duration(seconds: 2)));
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Cut to U01–U12?'),
        content: const Text('Remaining arms (after the current one) drop '
            'cards U13–U20. Arms are never cut. This can\'t be undone.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Cut')),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() {
      _cutFromBlock = _blockIx + 1;
      _sequence = cutToU12(_sequence, _cutFromBlock!);
    });
    await widget.queue.enqueueText(
        text: 'cut-to-U12 applied after arm ${_block.label}',
        sessionId: widget.settings().sessionId,
        deviceProvenance: const {'source': 'walkthrough'});
    _persistProgress(nextStepIx: _stepIx);
  }

  // ── UI ─────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: _phase != _Phase.running,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final leave = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Leave walkthrough?'),
            content: const Text('Progress is saved and captured cards are '
                'already queued. You can resume later.'),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(ctx, false),
                  child: const Text('Stay')),
              FilledButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  child: const Text('Leave')),
            ],
          ),
        );
        if (leave != true || !mounted) return;
        Navigator.of(this.context).pop();
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(_phase == _Phase.running
              ? '${_sequence.name} — ${_block.label}'
              : '${widget.sequence.name} walkthrough'),
          actions: [
            if (_phase == _Phase.running && _sequence.name == 'field')
              PopupMenuButton<String>(
                onSelected: (_) => _cutToU12(),
                itemBuilder: (_) => const [
                  PopupMenuItem(
                      value: 'cut', child: Text('Cut to U01–U12 (time-box)')),
                ],
              ),
          ],
        ),
        body: switch (_phase) {
          _Phase.setup => _setupView(),
          _Phase.running => _runnerView(),
          _Phase.complete => _completionView(),
        },
      ),
    );
  }

  Widget _setupView() {
    final expected = expectedCaptureCount(_sequence);
    return ListView(padding: const EdgeInsets.all(16), children: [
      Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${widget.sequence.name} walkthrough',
                style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            Text('${_sequence.blocks.length} sections · '
                '$expected captures expected'),
          ]),
        ),
      ),
      const SizedBox(height: 8),
      TextField(
        controller: _sessionIdCtl,
        decoration: const InputDecoration(
            labelText: 'Session id', border: OutlineInputBorder()),
        onChanged: (_) => setState(() {}),
      ),
      const SizedBox(height: 8),
      Row(children: [
        Icon(Icons.circle,
            size: 12,
            color: switch (_pingOk) {
              true => Colors.green,
              false => Colors.red,
              null => Colors.grey,
            }),
        const SizedBox(width: 8),
        Expanded(
            child: Text(widget.settings().receiverUrl.isEmpty
                ? 'No receiver URL — set it in Settings first'
                : widget.settings().receiverUrl)),
        OutlinedButton(
            onPressed: _pinging ? null : _ping,
            child: Text(_pinging ? 'Pinging…' : 'Ping')),
      ]),
      const SizedBox(height: 16),
      FilledButton(
        onPressed:
            (_pingOk == true && _sessionIdCtl.text.trim().isNotEmpty)
                ? _start
                : null,
        child: const Padding(
            padding: EdgeInsets.all(12), child: Text('Start')),
      ),
      if (_pingOk == false)
        const Padding(
          padding: EdgeInsets.only(top: 8),
          child: Text('Receiver unreachable — check Wi-Fi and that the '
              'receiver is running. The walkthrough won\'t start without a '
              'green ping.'),
        ),
    ]);
  }

  Widget _runnerView() {
    final totalSteps = _sequence.blocks.fold<int>(0, (n, b) => n + b.steps.length);
    final doneSteps = _sequence.blocks
            .take(_blockIx)
            .fold<int>(0, (n, b) => n + b.steps.length) +
        _stepIx;
    final micMode = (_snapshot['micMode'] as Map?)?.cast<String, dynamic>();
    final route = (_snapshot['route'] as Map?)?.cast<String, dynamic>();
    final inputs = (route?['inputs'] as List?) ?? const [];
    final routeText = inputs.isEmpty
        ? 'no input'
        : (inputs.first as Map)['portType'].toString();

    return Column(children: [
      LinearProgressIndicator(value: totalSteps == 0 ? 0 : doneSteps / totalSteps),
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
        child: Row(children: [
          Expanded(
              child: Text(
                  'Section ${_blockIx + 1}/${_sequence.blocks.length} · '
                  'step ${_stepIx + 1}/${_block.steps.length}',
                  style: Theme.of(context).textTheme.bodySmall)),
          _chip('mode: ${micMode?['active'] ?? '—'}'),
          const SizedBox(width: 4),
          _chip(routeText),
          const SizedBox(width: 4),
          _chip('⇡${_queueSummary.pending}'),
        ]),
      ),
      if (_problems.isNotEmpty)
        MaterialBanner(
          content: Text(_problems.join('\n')),
          backgroundColor: Theme.of(context).colorScheme.errorContainer,
          actions: [_retryAction()],
        ),
      Expanded(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: switch (_step) {
            final InstructionStep s => _instructionBody(s),
            final ConfigureArmStep s => _configureBody(s),
            final SettleStep s => _settleBody(s),
            final CardStep s => _cardBody(s),
          },
        ),
      ),
      const Padding(
        padding: EdgeInsets.only(bottom: 8),
        child: Text('Keep the app in the foreground',
            style: TextStyle(fontSize: 12)),
      ),
    ]);
  }

  Widget _chip(String text) => Chip(
      label: Text(text, style: const TextStyle(fontSize: 11)),
      visualDensity: VisualDensity.compact,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap);

  Widget _retryAction() {
    final step = _step;
    return TextButton(
      onPressed: () {
        switch (step) {
          case final SettleStep s:
            _startSettle(s);
          case final ConfigureArmStep s:
            setState(() => _problems = []);
            _runConfigure(s);
          default:
            setState(() => _problems = []);
        }
      },
      child: const Text('Retry'),
    );
  }

  Widget _instructionBody(InstructionStep s) {
    return ListView(children: [
      Text(s.title, style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: 12),
      Text(s.body, style: Theme.of(context).textTheme.bodyLarge),
      if (s.allowsFreeText) ...[
        const SizedBox(height: 12),
        TextField(
            controller: _freeTextCtl,
            decoration: const InputDecoration(
                labelText: 'Notes', border: OutlineInputBorder()),
            maxLines: 3),
      ],
      const SizedBox(height: 16),
      FilledButton(
          onPressed: () => _acknowledge(s),
          child: const Padding(
              padding: EdgeInsets.all(12), child: Text('Acknowledge'))),
    ]);
  }

  Widget _configureBody(ConfigureArmStep s) {
    final v = validateSnapshot(s.arm, _snapshot, requireMode: false);
    final ready = _configureDone && v.ok;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Arm: ${s.arm.label}',
          style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: 8),
      Text('Profile ${s.arm.profile} · expects '
          '${s.arm.expectedPortTypes.join(' or ')}'
          '${s.arm.expectedMode != null ? ' · mode ${s.arm.expectedMode} (set on the next step)' : ''}'),
      const SizedBox(height: 12),
      Row(children: [
        Icon(ready ? Icons.check_circle : Icons.pending,
            color: ready ? Colors.green : Colors.orange),
        const SizedBox(width: 8),
        Expanded(
            child: Text(ready
                ? 'Route matches.'
                : (v.problems.isEmpty
                    ? 'Applying profile…'
                    : v.problems.join('\n')))),
      ]),
      const SizedBox(height: 12),
      if (s.arm.isBt)
        const Text('Headset connected? If the route won\'t stick, toggle the '
            'headset connection, then Re-apply.'),
      const SizedBox(height: 8),
      Row(children: [
        OutlinedButton(
            onPressed: _capture == _CaptureStatus.idle
                ? () => _runConfigure(s)
                : null,
            child: const Text('Re-apply profile')),
        const SizedBox(width: 8),
        OutlinedButton(
            onPressed: () async {
              try {
                await widget.channel.showInputPicker();
              } on PlatformException {
                // iOS < 26 — button is a no-op there
              }
            },
            child: const Text('Input picker')),
      ]),
      const Spacer(),
      FilledButton(
          onPressed: ready ? _advance : null,
          child: const Padding(
              padding: EdgeInsets.all(12), child: Text('Next'))),
    ]);
  }

  Widget _settleBody(SettleStep s) {
    final active = ((_snapshot['micMode'] as Map?)?['active'])?.toString();
    final matched = active == s.arm.expectedMode;
    final capturing = _capture == _CaptureStatus.capturing;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Set mic mode: ${s.arm.expectedMode}',
          style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: 8),
      const Text('A settling capture is running and the system sheet should '
          'be open. Pick the mode above, close the sheet, and wait for the '
          'chip to turn green.'),
      const SizedBox(height: 16),
      Center(
          child: Chip(
        avatar: Icon(matched ? Icons.check_circle : Icons.hourglass_top,
            color: matched ? Colors.green : Colors.orange, size: 18),
        label: Text('active: ${active ?? '—'}',
            style: const TextStyle(fontSize: 16)),
      )),
      const SizedBox(height: 12),
      Center(
          child: TextButton(
              onPressed: capturing
                  ? () => widget.channel.showMicModeUI()
                  : null,
              child: const Text('Reopen mode sheet'))),
      const Spacer(),
      FilledButton(
          onPressed: capturing && matched ? () => _finishSettle(s) : null,
          child: const Padding(
              padding: EdgeInsets.all(12), child: Text('Done'))),
    ]);
  }

  Widget _cardBody(CardStep s) {
    final gate = validateSnapshot(s.arm, _snapshot, requireMode: true);
    final capturing = _capture == _CaptureStatus.capturing;
    final stopping = _capture == _CaptureStatus.stopping;
    final elapsed = _recStart == null || !capturing
        ? ''
        : ' · ${DateTime.now().difference(_recStart!).inSeconds}s';
    final modeBlocked = gate.problems.any((p) => p.startsWith('mic mode'));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text(s.utteranceId,
          style: Theme.of(context).textTheme.titleLarge,
          textAlign: TextAlign.center),
      const SizedBox(height: 12),
      Expanded(
        child: Center(
            child: Text(s.phrase,
                style: Theme.of(context).textTheme.headlineMedium,
                textAlign: TextAlign.center)),
      ),
      const Text('Flubbed the words? Finish the capture and move on — '
          'don\'t re-record.',
          style: TextStyle(fontSize: 12), textAlign: TextAlign.center),
      const SizedBox(height: 8),
      if (!capturing && !gate.ok) ...[
        Text(gate.problems.join('\n'), textAlign: TextAlign.center),
        const SizedBox(height: 8),
        if (modeBlocked)
          OutlinedButton(
              onPressed: () {
                setState(() {
                  _injectedSettle =
                      SettleStep('${s.id}/re-settle', arm: s.arm);
                });
                _enterStep();
              },
              child: const Text('Fix mode (re-settle)'))
        else
          OutlinedButton(
              onPressed: () => _runConfigure(
                  ConfigureArmStep('${s.id}/re-configure', arm: s.arm)),
              child: const Text('Re-apply profile')),
        const SizedBox(height: 8),
      ],
      SizedBox(
        height: 64,
        child: FilledButton.icon(
          style: FilledButton.styleFrom(
              backgroundColor: capturing ? Colors.red : null),
          icon: Icon(capturing ? Icons.stop : Icons.mic),
          label: Text(
              stopping ? 'Saving…' : (capturing ? 'STOP$elapsed' : 'RECORD'),
              style: const TextStyle(fontSize: 20)),
          onPressed: stopping
              ? null
              : capturing
                  ? () => _stopCard(s)
                  : (gate.ok ? () => _startCard(s) : null),
        ),
      ),
    ]);
  }

  Widget _completionView() {
    final audio =
        _sessionEntries.where((e) => e.payloadKind == 'audio').toList();
    final byArm = <String, int>{};
    for (final e in audio) {
      byArm[e.armLabel] = (byArm[e.armLabel] ?? 0) + 1;
    }
    final expected = expectedCaptureCount(_sequence);
    return ListView(padding: const EdgeInsets.all(16), children: [
      Text('Walkthrough complete',
          style: Theme.of(context).textTheme.titleLarge),
      const SizedBox(height: 12),
      Text('Session ${widget.settings().sessionId}: ${audio.length} captures '
          'queued (expected $expected).'),
      const SizedBox(height: 8),
      for (final entry in byArm.entries) Text('  ${entry.key}: ${entry.value}'),
      const SizedBox(height: 12),
      Text('Queue — pending ${_queueSummary.pending} · parked '
          '${_queueSummary.parked} · synced ${_queueSummary.synced}'),
      const SizedBox(height: 8),
      const Text('Keep the app open until pending reaches 0 — sync continues '
          'in the background of this screen.'),
      const SizedBox(height: 16),
      FilledButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Padding(
              padding: EdgeInsets.all(12), child: Text('Done'))),
    ]);
  }
}
