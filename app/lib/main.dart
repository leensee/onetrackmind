import 'package:flutter/material.dart';

void main() {
  runApp(const OTMApp());
}

class OTMApp extends StatelessWidget {
  const OTMApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      title: 'OneTrackMind',
      home: Scaffold(
        body: Center(
          child: Text(
            'OneTrackMind',
            style: TextStyle(fontSize: 24),
          ),
        ),
      ),
    );
  }
}
