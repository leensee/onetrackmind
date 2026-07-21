import Flutter
import UIKit

class SceneDelegate: FlutterSceneDelegate {

  // t_appActive in the Q3 latency chain (intent perform → app active →
  // session active → first audio buffer).
  override func sceneDidBecomeActive(_ scene: UIScene) {
    super.sceneDidBecomeActive(scene)
    CaptureCoordinator.shared.noteAppActive()
  }
}
