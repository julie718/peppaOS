import UIKit
import Capacitor
import WebKit

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

    // P0-4 白屏兜底（iOS 原生层看门狗）：viewDidAppear 后启动，
    // 与网页层内联脚本（index.*.html 的 mayos-fallback）组成双层兜底。
    private var whiteScreenGuard: MayOSWhiteScreenGuard?

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard whiteScreenGuard == nil else { return }
        guard let webView = self.webView else { return }
        let guarder = MayOSWhiteScreenGuard(webView: webView)
        guarder.start(presentingIn: self.view)
        whiteScreenGuard = guarder
    }
}

/// P0-4 原生层白屏看门狗：
/// 若 WebView 加载后 12s 内 React 应用未挂载（#root 无子节点 / JS 求值失败 /
/// 页面未加载），判定为白屏 — 叠加原生深色遮罩（非白屏、可操作），
/// 提供"重试"按钮 reload WebView。与网页层兜底互补：网页层兜 JS 崩溃/资源失败，
/// 原生层兜 WebView 整体异常/服务器不可达（evaluateJavaScript 永不回调也能触发）。
class MayOSWhiteScreenGuard: NSObject {
    private weak var webView: WKWebView?
    private weak var presenter: UIView?
    private var overlay: UIView?
    private var pollTimer: Timer?
    private let pollInterval: TimeInterval = 1.0
    private let maxWaitSeconds: TimeInterval = 12.0
    private var elapsed: TimeInterval = 0
    private var mounted = false

    init(webView: WKWebView?) {
        self.webView = webView
    }

    deinit { stop() }

    func start(presentingIn parent: UIView) {
        stop()
        presenter = parent
        elapsed = 0
        mounted = false
        pollTimer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func tick() {
        guard !mounted, let webView = self.webView else { return }
        elapsed += pollInterval
        // 无论 JS 求值是否回调，超时即兜底（页面未加载时 evaluateJavaScript 可能不回调）
        if elapsed >= maxWaitSeconds {
            showOverlay()
        }
        webView.evaluateJavaScript(
            "document.getElementById('root') ? document.getElementById('root').childElementCount > 0 : false"
        ) { [weak self] result, error in
            guard let self = self, !self.mounted else { return }
            if error == nil, let ok = result as? Bool, ok {
                self.mounted = true
                self.hideOverlay()
                self.stop()
            }
        }
    }

    private func showOverlay() {
        guard overlay == nil, let presenter = self.presenter else { return }
        let ov = UIView(frame: presenter.bounds)
        ov.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        ov.backgroundColor = UIColor(red: 0.024, green: 0.031, blue: 0.05, alpha: 1) // #060810 与 App 底色一致
        let stack = UIStackView()
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.color = .white
        spinner.startAnimating()
        let label = UILabel()
        label.text = "正在连接 Peppa…"
        label.textColor = .white
        label.font = .systemFont(ofSize: 15)
        let retry = UIButton(type: .system)
        retry.setTitle("网络异常，点击重试", for: .normal)
        retry.titleLabel?.font = .systemFont(ofSize: 13)
        retry.setTitleColor(UIColor(red: 1.0, green: 0.76, blue: 0.29, alpha: 1), for: .normal) // 琥珀色
        retry.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)
        stack.addArrangedSubview(spinner)
        stack.addArrangedSubview(label)
        stack.addArrangedSubview(retry)
        ov.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: ov.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: ov.centerYAnchor),
        ])
        overlay = ov
        presenter.addSubview(ov)
    }

    private func hideOverlay() {
        overlay?.removeFromSuperview()
        overlay = nil
    }

    @objc private func retryTapped() {
        hideOverlay()
        webView?.reload()
        // 重启看门狗（start() 内部先 stop() 再重置计时）
        if let presenter = self.presenter {
            start(presentingIn: presenter)
        }
    }
}
