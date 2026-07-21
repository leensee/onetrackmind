import 'package:flutter/material.dart';

import 'bench/bench_screen.dart';

void main() {
  runApp(const OTMApp());
}

class OTMApp extends StatelessWidget {
  const OTMApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      title: 'OneTrackMind',
      home: BenchScreen(),
    );
  }
}
