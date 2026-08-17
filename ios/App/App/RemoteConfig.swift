import Foundation

/// 远程应用配置：App 启动时（WebView 加载前）请求
/// <编译期内嵌域名>/config.json 获取最新 apiBase，并覆盖编译期内嵌的 server.url。
///
/// 以后服务器域名变更只需修改服务器上的 config.json（指向新域名），
/// 无需重新编译 App —— 前提是旧域名在迁移过渡期继续对外提供 config.json。
///
/// 拉取失败（网络不可用/超时）时依次回退：
///   1. 上次成功拉取并缓存的 apiBase（UserDefaults）
///   2. 编译期内嵌地址（最后兜底，保证 App 一定能启动）
enum RemoteConfig {
    /// config.json 拉取超时（秒）。等待期间主线程阻塞，由启动画面兜底视觉。
    private static let fetchTimeout: TimeInterval = 4.0
    /// 成功解析到的 apiBase 缓存 key
    private static let cachedApiBaseKey = "mayos_remote_api_base"

    /// 根据编译期内嵌的 serverURL（如 https://peppaos.qweasd.top/index.mobile.html）
    /// 解析 WebView 起始 URL：请求 <origin>/config.json 获取 apiBase，
    /// 返回 <apiBase>/index.mobile.html；失败时按上述顺序回退。
    static func resolveStartURL(embeddedServerURL: String?) -> String? {
        guard let embedded = embeddedServerURL,
              let embeddedURL = URL(string: embedded),
              let origin = origin(of: embeddedURL) else {
            return nil // 内嵌配置异常则交给 Capacitor 默认行为
        }

        // 1) 拉取远程配置
        if let apiBase = fetchApiBase(from: origin) {
            if let startURL = startURL(apiBase: apiBase) {
                cache(apiBase)
                return startURL
            }
            return embedded // 配置损坏（非 http/https）则不使用
        }

        // 2) 回退：上次成功缓存（可能比编译期内嵌更新）
        if let cached = UserDefaults.standard.string(forKey: cachedApiBaseKey),
           cached != origin.absoluteString,
           let startURL = startURL(apiBase: cached) {
            return startURL
        }

        // 3) 回退：编译期内嵌地址
        return embedded
    }

    // MARK: - 私有

    /// 拼接 <apiBase>/index.mobile.html，并校验协议为 http/https
    private static func startURL(apiBase: String) -> String? {
        let trimmed = apiBase.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil else {
            return nil
        }
        let base = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        return "\(base)/index.mobile.html"
    }

    /// 同步拉取 <origin>/config.json，返回 apiBase 字段；超时或失败返回 nil。
    /// 在后台线程发起请求，用信号量阻塞当前（主）线程最多 fetchTimeout 秒。
    private static func fetchApiBase(from origin: URL) -> String? {
        let configURL = origin.appendingPathComponent("config.json")
        let semaphore = DispatchSemaphore(value: 0)
        var result: String?

        var request = URLRequest(url: configURL)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = fetchTimeout

        URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            guard error == nil,
                  let data = data,
                  let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let apiBase = json["apiBase"] as? String else {
                return
            }
            result = apiBase
        }.resume()

        _ = semaphore.wait(timeout: .now() + fetchTimeout + 1)
        return result
    }

    /// 提取 URL 的 origin（scheme://host[:port]）
    private static func origin(of url: URL) -> URL? {
        guard let scheme = url.scheme, let host = url.host else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        if let port = url.port { components.port = port }
        return components.url
    }

    private static func cache(_ apiBase: String) {
        UserDefaults.standard.set(apiBase, forKey: cachedApiBaseKey)
    }
}
