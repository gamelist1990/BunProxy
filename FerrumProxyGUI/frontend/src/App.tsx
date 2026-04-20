import { useState, useEffect } from "react";
import "./App.css";
import { useWebSocket } from "./useWebSocket";
import type {
  FerrumProxyInstance,
  LogEntry,
  FerrumProxyConfig,
  FerrumProxyPlatform,
  AuthStatus,
  PlayerIPEntry,
} from "./api";
import {
  fetchInstances,
  createInstance,
  deleteInstance,
  startInstance,
  stopInstance,
  restartInstance,
  fetchLogs,
  fetchConfig,
  updateConfig,
  checkUpdates,
  fetchLatestRelease,
  fetchAllReleases,
  checkAuthStatus,
  login,
  logout,
  setupAuth,
  fetchPlayerIPs,
  updateInstance,
  updateInstanceMetadata,
  fetchSystemInfo,
} from "./api";
import { t, setLanguage, getLanguage, type Language } from "./lang";
import { Login } from "./components/Login";
import { ConfigEditor } from "./components/ConfigEditor";
import { PlayerIPList } from "./components/PlayerIPList";
import { UpdateProgress } from "./components/UpdateProgress";
import { InstanceSettingsModal } from "./components/InstanceSettingsModal";
import { formatLogMessage } from "./utils/ansi";
import { DEFAULT_FERRUMPROXY_VERSION } from "./utils/version";
import type { WebSocketEventMap, UpdateCheckResult } from "./api";
import { LOG_DISPLAY_LIMIT } from "./utils/constants";

function App() {
  const [instances, setInstances] = useState<FerrumProxyInstance[]>([]);
  const [selectedInstance, setSelectedInstance] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [config, setConfig] = useState<FerrumProxyConfig | null>(null);
  const [playerIPs, setPlayerIPs] = useState<PlayerIPEntry[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [initializingInstances, setInitializingInstances] = useState<
    Set<string>
  >(new Set());
  const [updatingInstances, setUpdatingInstances] = useState<
    Map<string, { progress: number; targetVersion: string }>
  >(new Map());
  const [latestVersion, setLatestVersion] = useState<string>(
    DEFAULT_FERRUMPROXY_VERSION
  );
  const [availableVersions, setAvailableVersions] = useState<string[]>([
    DEFAULT_FERRUMPROXY_VERSION,
  ]);
  const [language, setLang] = useState<Language>(getLanguage());
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme");
    if (saved) return saved as "light" | "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  const [newInstanceForm, setNewInstanceForm] = useState({
    name: "",
    platform: "linux" as FerrumProxyPlatform,
    version: DEFAULT_FERRUMPROXY_VERSION,
  });

  const { isConnected, on } = useWebSocket();


  const handleLanguageChange = (lang: Language) => {
    setLanguage(lang);
    setLang(lang);
  };

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  };

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    if (authStatus?.requireAuth && !authStatus?.isAuthenticated) return;

    fetchSystemInfo()
      .then((info) => {
        if (info && info.platform) {
          setNewInstanceForm((prev) => ({ ...prev, platform: info.platform }));
        }
      })
      .catch(() => {});
  }, [authChecked, authStatus]);

  const checkAuth = async () => {
    try {
      const status = await checkAuthStatus();
      setAuthStatus(status);
      setAuthChecked(true);

      if (status.isAuthenticated) {
        loadInstances();
      }
    } catch (error) {
      console.error("Auth check failed:", error);
      setAuthChecked(true);
    }
  };

  async function handleLogin(username: string, password: string) {
    if (!authStatus) return;

    if (authStatus.hasAuth) {
      await login(username, password);
    } else {
      await setupAuth(username, password);
    }

    await checkAuth();
  }

  async function handleLogout() {
    await logout();
    setAuthStatus({ hasAuth: true, isAuthenticated: false, requireAuth: true });
    setInstances([]);
    setSelectedInstance(null);
  }

  useEffect(() => {
    if (authStatus?.isAuthenticated) {
      loadInstances();
    }
  }, [authStatus]);

  useEffect(() => {
    const unsubscribes = [
      on("instances", (data: WebSocketEventMap["instances"]) => {
        const instancesData = Array.isArray(data) ? data : data.data || [];
        setInstances(instancesData);
      }),
      on("instanceAdded", () => loadInstances()),
      on("instanceRemoved", () => loadInstances()),
      on("instanceStarted", (data: WebSocketEventMap["instanceStarted"]) => {
        setInstances((prev) =>
          Array.isArray(prev)
            ? prev.map((inst) =>
                inst.id === data.instanceId
                  ? {
                      ...inst,
                      pid: data.pid,
                      lastStarted: new Date().toISOString(),
                    }
                  : inst
              )
            : prev
        );
      }),
      on("instanceStopped", (data: WebSocketEventMap["instanceStopped"]) => {
        setInstances((prev) =>
          Array.isArray(prev)
            ? prev.map((inst) =>
                inst.id === data.instanceId
                  ? { ...inst, pid: undefined, lastStarted: undefined }
                  : inst
              )
            : prev
        );
      }),
      on(
        "instanceRestarted",
        (data: WebSocketEventMap["instanceRestarted"]) => {
          setInstances((prev) =>
            Array.isArray(prev)
              ? prev.map((inst) =>
                  inst.id === data.instanceId
                    ? {
                        ...inst,
                        pid: data.pid,
                        lastStarted: new Date().toISOString(),
                      }
                    : inst
                )
              : prev
          );
        }
      ),
      on("processExit", (data: WebSocketEventMap["processExit"]) => {
        setInstances((prev) =>
          Array.isArray(prev)
            ? prev.map((inst) =>
                inst.id === data.instanceId ? { ...inst, pid: undefined } : inst
              )
            : prev
        );
      }),
      on(
        "instanceInitializing",
        (data: WebSocketEventMap["instanceInitializing"]) => {
          setInitializingInstances((prev) =>
            new Set(prev).add(data.instanceId)
          );
        }
      ),
      on(
        "instanceInitialized",
        (data: WebSocketEventMap["instanceInitialized"]) => {
          setInitializingInstances((prev) => {
            const next = new Set(prev);
            next.delete(data.instanceId);
            return next;
          });
          loadInstances();
        }
      ),
      on("updateProgress", (data: WebSocketEventMap["updateProgress"]) => {
        setUpdatingInstances((prev) => {
          const next = new Map(prev);
          const current = next.get(data.instanceId);
          next.set(data.instanceId, {
            progress: data.percentage,
            targetVersion: current?.targetVersion || "unknown",
          });
          return next;
        });
      }),
      on("instanceUpdated", (data: WebSocketEventMap["instanceUpdated"]) => {
        setUpdatingInstances((prev) => {
          const next = new Map(prev);
          next.delete(data.instanceId);
          return next;
        });
        loadInstances();
        alert(`アップデートが完了しました: v${data.version}`);
      }),
      on("log", (data: WebSocketEventMap["log"]) => {
        if (data.instanceId === selectedInstance) {
          setLogs((prev) => {
            const next = [
              ...prev,
              {
                timestamp: data.timestamp,
                type: data.logType as "stdout" | "stderr" | "system",
                message: data.message,
              },
            ];
            // Keep only the last N entries to avoid unbounded memory growth
            if (next.length > LOG_DISPLAY_LIMIT) {
              return next.slice(next.length - LOG_DISPLAY_LIMIT);
            }
            return next;
          });
        }
      }),
      on("configUpdated", (data: WebSocketEventMap["configUpdated"]) => {
        if (data.instanceId === selectedInstance) {
          setConfig(data.config);
        }
      }),
      on("rateLimitError", (data: WebSocketEventMap["rateLimitError"]) => {
        alert(`⚠️ ${data.message}`);
      }),
    ];

    return () => unsubscribes.forEach((unsub) => unsub());
  }, [on, selectedInstance]);

  useEffect(() => {
    if (selectedInstance) {
      loadLogs(selectedInstance);
      loadConfig(selectedInstance);
      loadPlayerIPs(selectedInstance);
    }
  }, [selectedInstance]);

  async function loadInstances() {
    try {
      const data = await fetchInstances();
      setInstances(data);
    } catch (error) {
      console.error(t("errorLoadInstances"), error);
    }
  }

  async function loadReleases() {
    try {
      const [latest, allReleases] = await Promise.all([
        fetchLatestRelease(),
        fetchAllReleases(),
      ]);
      setLatestVersion(latest.version);
      setAvailableVersions(allReleases.map((r) => r.version).filter((version) => version !== "latest"));
    } catch (error) {
      console.error(t("errorLoadRelease"), error);

      setLatestVersion(DEFAULT_FERRUMPROXY_VERSION);
      setAvailableVersions([]);
    }
  }

  async function loadLogs(instanceId: string) {
    try {
      const data = await fetchLogs(instanceId, LOG_DISPLAY_LIMIT);
      setLogs(data);
    } catch (error) {
      console.error(t("errorLoadLogs"), error);
    }
  }

  async function loadConfig(instanceId: string) {
    try {
      const data = await fetchConfig(instanceId);
      setConfig(data);
    } catch (error) {
      console.error(t("errorLoadConfig"), error);
    }
  }

  async function loadPlayerIPs(instanceId: string) {
    try {
      const data = await fetchPlayerIPs(instanceId);
      setPlayerIPs(data);
    } catch (error) {
      console.error("Failed to load player IPs", error);
      setPlayerIPs([]);
    }
  }

  async function handleCreateInstance() {
    try {
      setIsCreating(true);

      if (
        availableVersions.length === 1 &&
        availableVersions[0] === DEFAULT_FERRUMPROXY_VERSION
      ) {
        try {
          await loadReleases();
        } catch {
          console.warn("Failed to load releases, using default version");
        }
      }

      await createInstance(newInstanceForm);
      setNewInstanceForm({
        name: "",
        platform: "linux",
        version: DEFAULT_FERRUMPROXY_VERSION,
      });
      await loadInstances();
    } catch (error) {
      const err = error as Error;
      if (err.message && err.message.includes("レート制限")) {
        alert(
          `⚠️ ${err.message}\n\n新規インスタンスの作成と更新確認ができません。しばらく待ってから再度試してください。`
        );
      } else {
        alert(`${t("errorCreateInstance")} ${err.message}`);
      }
    } finally {
      setIsCreating(false);
    }
  }

  async function handleDeleteInstance(id: string) {
    if (!confirm(t("confirmDelete"))) return;

    try {
      await deleteInstance(id);
      if (selectedInstance === id) {
        setSelectedInstance(null);
      }
    } catch (error) {
      const err = error as Error;
      alert(`${t("errorDeleteInstance")} ${err.message}`);
    }
  }

  async function handleStartInstance(id: string) {
    try {
      await startInstance(id);
    } catch (error) {
      const err = error as Error;
      alert(`${t("errorStartInstance")} ${err.message}`);
    }
  }

  async function handleStopInstance(id: string) {
    try {
      await stopInstance(id);
    } catch (error) {
      const err = error as Error;
      alert(`${t("errorStopInstance")} ${err.message}`);
    }
  }

  async function handleRestartInstance(id: string) {
    try {
      await restartInstance(id);
    } catch (error) {
      const err = error as Error;
      alert(`${t("errorRestartInstance")} ${err.message}`);
    }
  }

  async function handleSaveConfig() {
    if (!selectedInstance || !config) return;

    try {
      await updateConfig(selectedInstance, config);
      alert(t("configSaved"));
    } catch (error) {
      const err = error as Error;
      alert(`${t("errorSaveConfig")} ${err.message}`);
    }
  }

  async function handleCheckUpdates() {
    try {
      await loadReleases();

      const data: UpdateCheckResult = await checkUpdates();
      const hasUpdates = data.updates.some((u) => u.hasUpdate);
      if (hasUpdates) {
        alert(`${t("updatesAvailable")} ${data.latestRelease.version}`);
      } else {
        alert(t("allUpToDate"));
      }
    } catch (error) {
      const err = error as Error;
      if (
        err.message &&
        (err.message.includes("rate limit") ||
          err.message.includes("レート制限"))
      ) {
        alert(
          `⚠️ GitHub APIのレート制限に達しました。\n\n更新確認ができません。しばらく待ってから再度試してください。`
        );
      } else {
        alert(`${t("errorCheckUpdates")} ${err.message}`);
      }
    }
  }

  async function handleUpdateInstance(
    instanceId: string,
    version: string = "latest",
    forceReinstall: boolean = false
  ) {
    try {
      setUpdatingInstances((prev) => {
        const next = new Map(prev);
        next.set(instanceId, { progress: 0, targetVersion: version });
        return next;
      });

      await updateInstance(instanceId, version, forceReinstall);
    } catch (error) {
      setUpdatingInstances((prev) => {
        const next = new Map(prev);
        next.delete(instanceId);
        return next;
      });

      const err = error as Error;
      if (
        err.message &&
        (err.message.includes("rate limit") ||
          err.message.includes("レート制限"))
      ) {
        alert(
          `⚠️ GitHub APIのレート制限に達しました。\n\nアップデートができません。しばらく待ってから再度試してください。`
        );
      } else {
        alert(`アップデートに失敗しました: ${err.message}`);
      }
    }
  }

  const selectedInstanceData = Array.isArray(instances)
    ? instances.find((i) => i.id === selectedInstance)
    : null;
  const updateProgress = selectedInstance
    ? updatingInstances.get(selectedInstance)
    : undefined;

  const [settingsModalOpen, setSettingsModalOpen] = useState(false);

  if (!authChecked) {
    return (
      <div className="app loading">
        <p>Loading...</p>
      </div>
    );
  }

  if (
    authStatus?.requireAuth ||
    (authStatus?.hasAuth && !authStatus?.isAuthenticated)
  ) {
    return <Login onLogin={handleLogin} isSetup={!authStatus?.hasAuth} />;
  }

  if (!authStatus?.hasAuth && authStatus?.isAuthenticated) {
    return (
      <div className="app setup-prompt">
        <div className="setup-card">
          <h2>🔒 {t("securitySetup")}</h2>
          <p>{t("noAuthConfigured")}</p>
          <p>{t("setupAuthPrompt")}</p>
          <Login onLogin={handleLogin} isSetup={true} />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>{t("appTitle")}</h1>
        <div className="connection-status">
          <span className={isConnected ? "connected" : "disconnected"}>
            {isConnected ? t("connected") : t("disconnected")}
          </span>
          <select
            value={language}
            onChange={(e) => handleLanguageChange(e.target.value as Language)}
          >
            <option value="ja_JP">日本語</option>
            <option value="en_US">English</option>
          </select>
          <button
            onClick={toggleTheme}
            title={
              theme === "light" ? "Switch to Dark Mode" : "Switch to Light Mode"
            }
          >
            {theme === "light" ? "Night" : "Light"}
          </button>
          <button onClick={handleCheckUpdates}>{t("checkUpdates")}</button>
          {latestVersion && (
            <span>
              {t("latest")}: v{latestVersion}
            </span>
          )}
          {authStatus?.hasAuth && (
            <button onClick={handleLogout} className="logout-btn">
              {t("logout")}
            </button>
          )}
        </div>
      </header>

      <div className="main-container">
        <aside className="sidebar">
          <h2>{t("instances")}</h2>
          <div className="instance-list">
            {Array.isArray(instances) &&
              instances.map((instance) => (
                <div
                  key={instance.id}
                  className={`instance-item ${
                    selectedInstance === instance.id ? "selected" : ""
                  } ${
                    initializingInstances.has(instance.id) ? "initializing" : ""
                  }`}
                  onClick={() => setSelectedInstance(instance.id)}
                >
                  <div className="instance-info">
                    <strong>{instance.name}</strong>
                    <span className="instance-status">
                      {initializingInstances.has(instance.id)
                        ? t("initializing")
                        : instance.pid
                        ? t("running")
                        : t("stopped")}
                    </span>
                    {instance.autoRestart && (
                      <span
                        className="auto-restart-badge"
                        title={t("autoRestart") || "自動起動"}
                        style={{
                          marginLeft: "0.5rem",
                          fontSize: "0.8rem",
                          color: "var(--primary-color)",
                        }}
                      ></span>
                    )}
                    <small>
                      {instance.platform} v{instance.version}
                    </small>
                  </div>
                </div>
              ))}
          </div>

          <div className="create-instance">
            <h3>{t("createNewInstance")}</h3>
            <input
              type="text"
              placeholder={t("placeholderInstanceName")}
              value={newInstanceForm.name}
              onChange={(e) =>
                setNewInstanceForm({ ...newInstanceForm, name: e.target.value })
              }
            />
            <select
              value={newInstanceForm.platform}
              onChange={(e) =>
                setNewInstanceForm({
                  ...newInstanceForm,
                  platform: e.target.value as FerrumProxyPlatform,
                })
              }
            >
              <option value="linux">{t("platformLinux")}</option>
              <option value="linux-arm64">{t("platformLinux")} (ARM64)</option>
              <option value="macos-arm64">{t("platformMacOS")}</option>
              <option value="windows">{t("platformWindows")}</option>
            </select>
            <select
              value={newInstanceForm.version}
              onChange={(e) =>
                setNewInstanceForm({
                  ...newInstanceForm,
                  version: e.target.value,
                })
              }
            >
              <option value="latest">
                {t("latestVersion") || "Latest"} ({latestVersion})
              </option>
              {availableVersions.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
            <button
              onClick={handleCreateInstance}
              disabled={isCreating || !newInstanceForm.name}
            >
              {isCreating ? t("creating") : t("createInstance")}
            </button>
          </div>
        </aside>

        <main className="content">
          {selectedInstanceData ? (
            <>
              <div className="instance-header">
                <h2>{selectedInstanceData.name}</h2>
                <div className="instance-actions">
                  {selectedInstanceData.pid ? (
                    <>
                      <button
                        onClick={() =>
                          handleStopInstance(selectedInstanceData.id)
                        }
                      >
                        {t("stop")}
                      </button>
                      <button
                        onClick={() =>
                          handleRestartInstance(selectedInstanceData.id)
                        }
                      >
                        {t("restart")}
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() =>
                        handleStartInstance(selectedInstanceData.id)
                      }
                    >
                      {t("start")}
                    </button>
                  )}

                  <button
                    onClick={() => setSettingsModalOpen(true)}
                    className="settings-btn"
                  >
                    {t("settings") || "設定"}
                  </button>

                  <button
                    onClick={() =>
                      handleDeleteInstance(selectedInstanceData.id)
                    }
                    className="danger"
                  >
                    {t("delete")}
                  </button>
                </div>
              </div>

              {updateProgress && (
                <UpdateProgress
                  isUpdating={true}
                  progress={updateProgress.progress}
                  currentVersion={selectedInstanceData.version}
                  targetVersion={updateProgress.targetVersion}
                />
              )}

              <InstanceSettingsModal
                isOpen={settingsModalOpen}
                onClose={() => setSettingsModalOpen(false)}
                instanceName={selectedInstanceData.name}
                instanceVersion={selectedInstanceData.version}
                autoStart={!!selectedInstanceData.autoStart}
                autoRestart={!!selectedInstanceData.autoRestart}
                onUpdateName={async (name) => {
                  await updateInstanceMetadata(selectedInstanceData.id, {
                    name,
                  });
                  setInstances((prev) =>
                    Array.isArray(prev)
                      ? prev.map((it) =>
                          it.id === selectedInstanceData.id
                            ? { ...it, name }
                            : it
                        )
                      : prev
                  );
                }}
                onToggleAutoStart={async (enabled) => {
                  await updateInstanceMetadata(selectedInstanceData.id, {
                    autoStart: enabled,
                  });
                  setInstances((prev) =>
                    Array.isArray(prev)
                      ? prev.map((it) =>
                          it.id === selectedInstanceData.id
                            ? { ...it, autoStart: enabled }
                            : it
                        )
                      : prev
                  );
                }}
                onToggleAutoRestart={async (enabled) => {
                  await updateInstanceMetadata(selectedInstanceData.id, {
                    autoRestart: enabled,
                  });
                  setInstances((prev) =>
                    Array.isArray(prev)
                      ? prev.map((it) =>
                          it.id === selectedInstanceData.id
                            ? { ...it, autoRestart: enabled }
                            : it
                        )
                      : prev
                  );
                }}
                onUpdateInstance={async (version, forceReinstall) => {
                  await handleUpdateInstance(
                    selectedInstanceData.id,
                    version,
                    !!forceReinstall
                  );
                }}
                availableVersions={availableVersions}
                latestVersion={latestVersion}
                isUpdating={updatingInstances.has(selectedInstanceData.id)}
              />

              <div className="tabs">
                <div className="tab-content">
                  <section className="console">
                    <h3>{t("consoleLogs")}</h3>
                    <div className="log-container">
                      {logs.map((log, i) => (
                        <div key={i} className={`log-entry log-${log.type}`}>
                          <span className="log-time">
                            {new Date(log.timestamp).toLocaleTimeString()}
                          </span>
                          <span className="log-type">
                            [
                            {log.type === "stdout"
                              ? t("logStdout")
                              : log.type === "stderr"
                              ? t("logStderr")
                              : t("logSystem")}
                            ]
                          </span>
                          <span
                            className="log-message"
                            dangerouslySetInnerHTML={{
                              __html: formatLogMessage(log.message),
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="config">
                    <h3>{t("configuration")}</h3>
                    {config && (
                      <ConfigEditor
                        instanceId={selectedInstanceData.id}
                        config={config}
                        onChange={setConfig}
                        onSave={handleSaveConfig}
                      />
                    )}
                  </section>

                  {config?.savePlayerIP && (
                    <section className="player-ips">
                      <h3>プレイヤーIP記録</h3>
                      <PlayerIPList playerIPs={playerIPs} />
                      <button
                        onClick={() => loadPlayerIPs(selectedInstanceData.id)}
                        style={{ marginTop: "1rem" }}
                      >
                        更新
                      </button>
                    </section>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="no-selection">
              <p>{t("noSelection")}</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
