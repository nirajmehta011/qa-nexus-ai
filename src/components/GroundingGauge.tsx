import type { CSSProperties } from 'react'

/**
 * Circular Arc Grounding Score Gauge
 * Renders an animated SVG gauge representing selector grounding confidence & verification rate.
 */
export default function GroundingGauge({
  rate,
  count,
  verified = false,
  size = 'md',
  label = 'Grounding Score',
  className,
  style
}: {
  /** Grounding rate between 0 and 1 (or 0 to 100) */
  rate: number
  /** Number of grounded/verified selectors */
  count?: number
  /** Whether the locators were verified against a live browser */
  verified?: boolean
  size?: 'sm' | 'md' | 'lg'
  label?: string
  className?: string
  style?: CSSProperties
}) {
  // Normalize to 0-100 percentage
  const pct = Math.min(100, Math.max(0, Math.round(rate > 1 ? rate : rate * 100)))
  const hasData = rate > 0 || (count !== undefined && count > 0)

  const tone = !hasData
    ? 'var(--text-faint)'
    : pct >= 80
      ? 'var(--ok)'
      : pct >= 40
        ? 'var(--warn)'
        : 'var(--err)'

  const statusText = !hasData
    ? 'No DOM supplied'
    : verified
      ? 'Live-verified'
      : pct >= 80
        ? 'Excellent grounding'
        : pct >= 50
          ? 'Partial grounding'
          : 'Low grounding'

  // Dimensions based on size
  const config = {
    sm: { width: 100, height: 60, radius: 36, strokeWidth: 7, fontSize: '15px' },
    md: { width: 140, height: 84, radius: 52, strokeWidth: 9, fontSize: '20px' },
    lg: { width: 180, height: 106, radius: 68, strokeWidth: 11, fontSize: '26px' }
  }[size]

  // Semi-circle arc math
  const circumference = Math.PI * config.radius
  const strokeDashoffset = circumference - (pct / 100) * circumference

  return (
    <div
      className={`flex flex-col items-center justify-center ${className || ''}`}
      style={style}
      role="meter"
      aria-valuenow={hasData ? pct : 0}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${label}: ${hasData ? pct : 0}%`}
    >
      <p className="eyebrow leading-tight mb-1 text-center">{label}</p>

      <div className="relative flex items-center justify-center">
        <svg
          width={config.width}
          height={config.height}
          viewBox={`0 0 ${config.width} ${config.height + 6}`}
          className="overflow-visible"
        >
          <defs>
            <linearGradient id={`gauge-grad-${size}`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="var(--accent)" />
              <stop offset="100%" stopColor={tone} />
            </linearGradient>
          </defs>

          {/* Background track arc */}
          <path
            d={`M ${config.width / 2 - config.radius} ${config.height} A ${config.radius} ${config.radius} 0 0 1 ${config.width / 2 + config.radius} ${config.height}`}
            fill="none"
            stroke="var(--bg-hover)"
            strokeWidth={config.strokeWidth}
            strokeLinecap="round"
          />

          {/* Value progress arc */}
          {hasData && (
            <path
              d={`M ${config.width / 2 - config.radius} ${config.height} A ${config.radius} ${config.radius} 0 0 1 ${config.width / 2 + config.radius} ${config.height}`}
              fill="none"
              stroke={`url(#gauge-grad-${size})`}
              strokeWidth={config.strokeWidth}
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.16, 1, 0.3, 1)' }}
            />
          )}
        </svg>

        {/* Center Percentage Display */}
        <div
          className="absolute inset-0 flex flex-col items-center justify-end pb-0.5 text-center pointer-events-none"
        >
          <span
            className="mono font-bold leading-none tracking-tight"
            style={{ fontSize: config.fontSize, color: hasData ? 'var(--text)' : 'var(--text-faint)' }}
          >
            {hasData ? `${pct}%` : '—'}
          </span>
        </div>
      </div>

      <p
        className="text-[10.5px] font-medium leading-tight mt-1 text-center"
        style={{ color: hasData ? tone : 'var(--text-faint)' }}
      >
        {count !== undefined && count > 0 ? `${count} locators · ` : ''}
        {statusText}
      </p>
    </div>
  )
}
