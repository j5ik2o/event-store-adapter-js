export type RetryClock = {
  random: () => number;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};
