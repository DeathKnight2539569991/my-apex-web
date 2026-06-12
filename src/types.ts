export type MatchRecord = {
  id: string;
  playerId: string;
  kills: number;
  assists: number;
  knocks: number;
  damage: number;
  survivalSeconds: number;
  createdAt: string;
  sourceImageName?: string;
};

export type PlayerComment = {
  id: string;
  playerId: string;
  nickname: string;
  content: string;
  createdAt: string;
  likes: number;
};

export type MatchDraft = {
  playerId: string;
  kills: string;
  assists: string;
  knocks: string;
  damage: string;
  survivalTime: string;
};

export type SingleMatchMetrics = {
  survivalMinutes: number;
  dpm: number;
  damagePerKill: number | null;
  knockConversionRate: number | null;
  pureKnocks: number;
};

export type HistoryMetrics = {
  matchCount: number;
  totalDamage: number;
  totalKills: number;
  totalAssists: number;
  totalKnocks: number;
  totalPureKnocks: number;
  totalSurvivalSeconds: number;
  avgDamage: number;
  avgKills: number;
  avgAssists: number;
  avgKnocks: number;
  avgSurvivalSeconds: number;
  historicalDpm: number;
  historicalDamagePerKill: number | null;
  historicalKnockConversionRate: number | null;
  damageStability: number | null;
  finishDistribution: {
    kills: number;
    assists: number;
    pureKnocks: number;
  };
  radar: {
    avgDamage: number;
    avgKills: number;
    avgSurvivalTime: number;
    avgKnocks: number;
    finishConversion: number;
    outputStability: number;
  };
};

export type ZoneScoreComponent = {
  label: string;
  score: number;
  weight: number;
  playerValue: number | null;
  siteValue: number | null;
};

export type ZoneScore = {
  score: number;
  title: string;
  explanation: string;
  sampleWarning: string | null;
  components: ZoneScoreComponent[];
};

export type PlayerMetricsEntry = {
  playerId: string;
  metrics: HistoryMetrics;
};

export type CloudDataResponse = {
  matches: MatchRecord[];
  players: string[];
  siteMetrics: HistoryMetrics;
  playerMetrics: PlayerMetricsEntry[];
  adminDeleteEnabled: boolean;
};

export type CommentDataResponse = {
  comments: PlayerComment[];
};
