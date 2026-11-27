import { describe, it, expect } from 'vitest';
import { isOsintRelevant } from './newsRelevance';

describe('OSINT newsroom relevance', () => {
  it('excludes unrelated college and lifestyle news', () => {
    expect(isOsintRelevant("Beyond the Degree: How EDUHK's Honours College Prepares Students for What's Next")).toBe(false);
    expect(isOsintRelevant('Local university announces new scholarship')).toBe(false);
  });

  it('retains conflict and security reports from multiple viewpoints', () => {
    expect(isOsintRelevant('Yemeni media reported that an enemy drone was shot down')).toBe(true);
    expect(isOsintRelevant('Trump urges Russia to halt aggression in Europe')).toBe(true);
    expect(isOsintRelevant('Missile attacks reported in Ukraine')).toBe(true);
    expect(isOsintRelevant('Ransomware attack hits major hospital')).toBe(true);
  });

  it('includes disasters with real disruption but not regular forecasts', () => {
    expect(isOsintRelevant('Thanksgiving storms leave nearly a million without power across the US')).toBe(true);
    expect(isOsintRelevant('Storms expected this weekend, meteorologists say')).toBe(false);
    expect(isOsintRelevant('Flooding continues', 'Several thousand homes were destroyed')).toBe(true);
  });

  it('uses geographic context with the summary for understated headlines', () => {
    expect(isOsintRelevant('Latest from Gaza', 'Military strikes hit southern towns')).toBe(true);
    expect(isOsintRelevant('Latest from Gaza', 'Residents opened a new museum')).toBe(false);
  });
});
