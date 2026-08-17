import UIKit
import Capacitor

/// 在 Capacitor 解析配置（loadView → instanceDescriptor）阶段，
/// 用远程配置（config.json 返回的 apiBase）覆盖编译期内嵌的 server.url，
/// 使 WebView 的起始 URL 指向服务器最新域名。
class MayOSBridgeViewController: CAPBridgeViewController {
    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        if let resolved = RemoteConfig.resolveStartURL(embeddedServerURL: descriptor.serverURL) {
            descriptor.serverURL = resolved
        }
        return descriptor
    }
}
