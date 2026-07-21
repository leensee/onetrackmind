import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'capture_channel.dart';
import 'capture_queue.dart';
import 'models.dart';
import 'submit_client.dart';

/// One-screen bench instrument: profile/arm/utterance selection, record/stop,
/// live session snapshot (the Q1/Q2 evidence pane), queue status, receiver
/// settings, and an event log.
class BenchScreen extends StatefulWidget {
  const BenchScreen({super.key});

  @override
  State<BenchScreen> createState() => _BenchScreenState();
}

class _BenchScreenState extends State<BenchScreen>
    with WidgetsBindingObserver {
  static const profiles = ['vp-mode', 'vp-engine', 'raw', 'bt-hq'];
  static const armLabels = [
    'dev-test',
    'builtin-raw',
    'builtin+vi',
    'builtin-std',
    'ac-bt+vi',
    'ac-bt-std',
    'bc-bt+vi',
    'bc-bt-std',
    'builtin-earsplugged',
    'builtin-mounted-fixed',
  ];
  static final utteranceIds = [
    'none',
    for (var i = 1; i <= 20; i++) 'U${i.toString().padLeft(2, '0')}',
  ];

  final _channel = CaptureChannel();
  final _client = SubmitClient();
  CaptureQueue? _queue;
  BenchSettings _settings = const BenchSettings();
  File? _settingsFile;

  String _profile = 'vp-mode';
  String _armLabel = 'dev-test';
  String _utteranceId = 'none';
  bool _recording = false;
  Map<String, dynamic> _snapshot = {};
  ({int pending, int parked, int synced}) _queueSummary =
      (pending: 0, parked: 0, synced: 0);
  bool? _receiverReachable;
  final List<String> _log = [];
  StreamSubscription<Map<String, dynamic>>? _events;
  Timer? _snapshotTimer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    try {
      final storage = await _channel.getStorageDir();
      _settingsFile = File('$storage/bench-settings.json');
      if (_settingsFile!.existsSync()) {
        _settings = BenchSettings.fromJson(
            (jsonDecode(await _settingsFile!.readAsString()) as Map)
                .cast<String, dynamic>());
      }
      _queue = await CaptureQueue.open(
        channel: _channel,
        client: _client,
        settings: () => _settings,
        log: _appendLog,
      );
      _queue!.startDraining();
      _events = _channel.events.listen(_onEvent);
      _snapshotTimer = Timer.periodic(
          const Duration(seconds: 2), (_) => _refreshSnapshot());
      await _channel.setDefaults(profile: _profile, armLabel: _armLabel);
      await _refreshSnapshot();
      await _refreshQueueSummary();
    } on PlatformException catch (e) {
      _appendLog('bootstrap failed: ${e.code} ${e.message}');
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _events?.cancel();
    _snapshotTimer?.cancel();
    _queue?.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final foreground = state == AppLifecycleState.resumed;
    _queue?.setForeground(foreground);
    if (foreground) {
      _queue?.drainOnce();
      _refreshSnapshot();
    }
  }

  // ── Actions ────────────────────────────────────────────────

  Future<void> _configure(String profile) async {
    try {
      final snapshot = await _channel.configureSession(profile);
      await _channel.setDefaults(profile: profile);
      setState(() {
        _profile = profile;
        _snapshot = snapshot;
      });
      _appendLog('configured $profile');
    } on PlatformException catch (e) {
      _appendLog('configure $profile failed: ${e.code} ${e.message}');
    }
  }

  Future<void> _toggleRecording() async {
    if (_recording) {
      try {
        final result = await _channel.stopCapture();
        setState(() => _recording = false);
        final entry = await _queue!.enqueueAudio(
          stopResult: result,
          sessionId: _settings.sessionId,
        );
        _appendLog('stopped ${entry.id} '
            '(${(result['durationMs'] as num).toStringAsFixed(0)} ms)');
        await _refreshQueueSummary();
        await _queue!.drainOnce();
        await _refreshQueueSummary();
      } on PlatformException catch (e) {
        _appendLog('stop failed: ${e.code} ${e.message}');
        setState(() => _recording = false);
      }
    } else {
      try {
        final id = await _channel.startCapture(
          triggerSource: 'ui-button',
          armLabel: _armLabel,
          utteranceId: _utteranceId == 'none' ? null : _utteranceId,
        );
        setState(() => _recording = true);
        _appendLog('recording $id ($_armLabel'
            '${_utteranceId == 'none' ? '' : ', $_utteranceId'})');
      } on PlatformException catch (e) {
        _appendLog('start failed: ${e.code} ${e.message}');
      }
    }
  }

  Future<void> _enqueueTextNote() async {
    final provenance =
        (_snapshot['device_provenance'] as Map?)?.cast<String, dynamic>() ??
            {'source': 'bench-ui'};
    final entry = await _queue!.enqueueText(
      text: 'bench text-note ${DateTime.now().toUtc().toIso8601String()}',
      sessionId: _settings.sessionId,
      deviceProvenance: provenance,
    );
    _appendLog('text note ${entry.id} queued');
    await _refreshQueueSummary();
  }

  Future<void> _ping() async {
    setState(() => _receiverReachable = null);
    final ok = await _client.ping(_settings.receiverUrl);
    setState(() => _receiverReachable = ok);
    _appendLog(ok ? 'receiver reachable' : 'receiver UNREACHABLE');
  }

  Future<void> _refreshSnapshot() async {
    try {
      final snapshot = await _channel.getSnapshot();
      if (mounted) setState(() => _snapshot = snapshot);
    } on PlatformException catch (e) {
      _appendLog('snapshot failed: ${e.code}');
    }
  }

  Future<void> _refreshQueueSummary() async {
    final summary = await _queue!.summary();
    if (mounted) setState(() => _queueSummary = summary);
  }

  Future<void> _saveSettings(BenchSettings settings) async {
    _settings = settings;
    await _settingsFile
        ?.writeAsString(jsonEncode(settings.toJson()));
    setState(() {});
  }

  void _onEvent(Map<String, dynamic> event) {
    final type = event['type'] as String?;
    final payload = (event['payload'] as Map?)?.cast<String, dynamic>() ?? {};
    switch (type) {
      case 'captureStarted':
        setState(() => _recording = true);
        _appendLog('event: captureStarted '
            '(${payload['triggerSource']}, ${payload['profile']})');
      case 'captureStopped':
        setState(() => _recording = false);
        _appendLog('event: captureStopped');
      case 'micModeChanged':
        _appendLog(
            'event: micMode ${payload['from']} → ${payload['to']}');
      case 'routeChange':
        _appendLog('event: routeChange (reason ${payload['reason']})');
        _refreshSnapshot();
      case 'interruption':
        _appendLog('event: interruption ${payload['phase']}');
      case 'intentTriggered':
        _appendLog('event: SIRI intent '
            '(protectedData=${payload['isProtectedDataAvailableAtPerform']})');
      case 'intentStartFailed':
        _appendLog('event: SIRI start FAILED: ${payload['reason']}');
      default:
        _appendLog('event: $type');
    }
  }

  void _appendLog(String line) {
    final stamp = DateTime.now().toIso8601String().substring(11, 19);
    if (!mounted) return;
    setState(() {
      _log.insert(0, '$stamp  $line');
      if (_log.length > 200) _log.removeLast();
    });
  }

  // ── UI ─────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('OTM Capture Bench')),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          _recordCard(),
          _snapshotCard(),
          _queueCard(),
          _settingsCard(),
          _logCard(),
        ],
      ),
    );
  }

  Widget _recordCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(children: [
              Expanded(
                child: DropdownButtonFormField<String>(
                  initialValue: _profile,
                  decoration: const InputDecoration(labelText: 'Profile'),
                  items: [
                    for (final p in profiles)
                      DropdownMenuItem(value: p, child: Text(p)),
                  ],
                  onChanged: _recording
                      ? null
                      : (p) => p == null ? null : _configure(p),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: DropdownButtonFormField<String>(
                  initialValue: _armLabel,
                  decoration: const InputDecoration(labelText: 'Arm'),
                  items: [
                    for (final a in armLabels)
                      DropdownMenuItem(value: a, child: Text(a)),
                  ],
                  onChanged: _recording
                      ? null
                      : (a) {
                          if (a == null) return;
                          setState(() => _armLabel = a);
                          _channel.setDefaults(armLabel: a);
                        },
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                width: 90,
                child: DropdownButtonFormField<String>(
                  initialValue: _utteranceId,
                  decoration: const InputDecoration(labelText: 'Card'),
                  items: [
                    for (final u in utteranceIds)
                      DropdownMenuItem(value: u, child: Text(u)),
                  ],
                  onChanged: _recording
                      ? null
                      : (u) => setState(() => _utteranceId = u ?? 'none'),
                ),
              ),
            ]),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: _queue == null ? null : _toggleRecording,
              icon: Icon(_recording ? Icons.stop : Icons.mic),
              label: Text(_recording ? 'STOP' : 'RECORD'),
              style: FilledButton.styleFrom(
                backgroundColor: _recording ? Colors.red : null,
                minimumSize: const Size.fromHeight(56),
              ),
            ),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                TextButton(
                  onPressed: () => _channel.showMicModeUI(),
                  child: const Text('Mic mode UI'),
                ),
                TextButton(
                  onPressed: () async {
                    try {
                      await _channel.showInputPicker();
                    } on PlatformException catch (e) {
                      _appendLog('input picker: ${e.code}');
                    }
                  },
                  child: const Text('Input picker'),
                ),
                TextButton(
                  onPressed: _queue == null ? null : _enqueueTextNote,
                  child: const Text('Text note'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _snapshotCard() {
    final session = (_snapshot['session'] as Map?)?.cast<String, dynamic>();
    final micMode = (_snapshot['micMode'] as Map?)?.cast<String, dynamic>();
    final route = (_snapshot['route'] as Map?)?.cast<String, dynamic>();
    final inputs = (route?['inputs'] as List?) ?? const [];
    final active = micMode?['active'] as String? ?? '—';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Live session', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 4),
            Text('mic mode: $active '
                '(preferred ${micMode?['preferred'] ?? '—'})',
                style: TextStyle(
                  fontWeight: FontWeight.bold,
                  color: active == 'voiceIsolation' ? Colors.green : null,
                )),
            Text('mode: ${session?['mode'] ?? '—'}   '
                'sampleRate: ${session?['sampleRate'] ?? '—'}'),
            for (final input in inputs)
              Text('in: ${(input as Map)['portType']} '
                  '(${input['portName']})'),
          ],
        ),
      ),
    );
  }

  Widget _queueCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            Expanded(
              child: Text('Queue — pending ${_queueSummary.pending} · '
                  'parked ${_queueSummary.parked} · '
                  'synced ${_queueSummary.synced}'),
            ),
            TextButton(
              onPressed: _queue == null
                  ? null
                  : () async {
                      await _queue!.drainOnce();
                      await _refreshQueueSummary();
                    },
              child: const Text('Drain now'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _settingsCard() {
    return Card(
      child: ExpansionTile(
        title: Text('Receiver — ${_settings.receiverUrl.isEmpty ? 'not set' : _settings.receiverUrl} '
            '${_receiverReachable == null ? '' : _receiverReachable! ? '●' : '○'}'),
        childrenPadding: const EdgeInsets.all(12),
        children: [
          TextFormField(
            initialValue: _settings.receiverUrl,
            decoration: const InputDecoration(
                labelText: 'Receiver URL (http://<mac-lan-ip>:8787)'),
            onFieldSubmitted: (v) => _saveSettings(BenchSettings(
                receiverUrl: v.trim(),
                secret: _settings.secret,
                sessionId: _settings.sessionId)),
          ),
          TextFormField(
            initialValue: _settings.secret,
            obscureText: true,
            decoration:
                const InputDecoration(labelText: 'Bench secret (per session)'),
            onFieldSubmitted: (v) => _saveSettings(BenchSettings(
                receiverUrl: _settings.receiverUrl,
                secret: v.trim(),
                sessionId: _settings.sessionId)),
          ),
          TextFormField(
            initialValue: _settings.sessionId,
            decoration: const InputDecoration(labelText: 'Session id'),
            onFieldSubmitted: (v) => _saveSettings(BenchSettings(
                receiverUrl: _settings.receiverUrl,
                secret: _settings.secret,
                sessionId: v.trim())),
          ),
          const SizedBox(height: 8),
          OutlinedButton(onPressed: _ping, child: const Text('Ping receiver')),
        ],
      ),
    );
  }

  Widget _logCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Log', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 4),
            for (final line in _log.take(40))
              Text(line,
                  style: const TextStyle(
                      fontFamily: 'Menlo', fontSize: 11, height: 1.3)),
          ],
        ),
      ),
    );
  }
}
