declare global {
  interface Window { gtag?: (...args: unknown[]) => void; }
}

export function trackGameStart(): void {
  window.gtag?.('event', 'game_start');
}

export function trackGameEnd(
  winnerTeam: number,
  playerWon: boolean,
  durationSec: number,
  ticks: number,
): void {
  window.gtag?.('event', 'game_end', {
    winner_team: winnerTeam,
    player_won: playerWon,
    duration_sec: Math.round(durationSec),
    ticks,
  });
}
