import "./UpdateProgress.css";

interface UpdateProgressProps {
  isUpdating: boolean;
  progress: number;
  currentVersion: string;
  targetVersion: string;
}

export function UpdateProgress({
  isUpdating,
  progress,
  currentVersion,
  targetVersion,
}: UpdateProgressProps) {
  if (!isUpdating) return null;

  return (
    <div className="update-progress-overlay">
      <div className="update-progress-modal">
        <h3>アップデート中...</h3>
        <div className="version-info">
          <span className="version-label">現在のバージョン:</span>
          <span className="version-current">{currentVersion}</span>
          <span className="version-arrow">→</span>
          <span className="version-target">{targetVersion}</span>
        </div>
        <div className="progress-container">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{
                transform: `scaleX(${
                  Math.max(0, Math.min(100, progress)) / 100
                })`,
              }}
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
              role="progressbar"
            />
          </div>
          <div className="progress-text">{progress}%</div>
        </div>
        <p className="update-message">
          ダウンロード中です。しばらくお待ちください...
        </p>
      </div>
    </div>
  );
}
