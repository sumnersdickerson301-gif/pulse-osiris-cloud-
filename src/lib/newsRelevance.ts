/**
 * OSIRIS live-feed relevance gate for general-purpose RSS newsrooms.
 *
 * This is deliberately deterministic, not an AI threat judgement. Curated
 * incident-reporting channels are not subject to this newsroom filter. Every
 * rejected headline stays available at its publisher's original feed.
 */
const INCIDENT = /\b(?:wars?|warfare|armed|militar(?:y|ies)|troops?|soldiers?|missiles?|rockets?|drones?|airstrikes?|strikes?|bomb(?:s|ed|ing)?|explosions?|shelling|artillery|attack(?:s|ed|ing)?|assaults?|raids?|interceptions?|clashes?|offensives?|invasions?|occupied|occupation|hostages?|kidnapp(?:ing|ed)|casualties|killed|wounded|evacuat(?:ed|ion|ions)|ceasefires?|truce|peace\s+talks?|sanctions?|embargo(?:es)?|blockade|insurgenc(?:y|ies)|coup|protests?|riots?|unrest|terror(?:ism|ist|ists)?|aggression|air\s+defen[cs]e|airspace\s+clos(?:ed|ure)|nuclear\s+(?:threat|weapon|plant)|border\s+(?:incident|clash|crossing)|ballistic)\b/i;
const CYBER = /\b(?:cyber(?:attack|security|warfare|crime)|ransomware|data\s+breach|hacker(?:s)?|hacking|malware|ddos|internet\s+blackout|internet\s+shutdown|critical\s+infrastructure|sabotage|espionage|spyware)\b/i;
const DISASTER = /\b(?:earthquakes?|tsunamis?|wildfires?|flood(?:s|ing|ed)?|landslides?|volcan(?:o|ic)|hurricanes?|typhoons?|tornado(?:es)?|cyclones?|storms?)\b/i;
const IMPACT = /\b(?:power\s+outage|power\s+cuts?|without\s+power|blackouts?|missing|dead|deaths?|fatalities|damage(?:d)?|destroyed|stranded|injured|emergency|evacuat(?:ion|ed)|displaced|infrastructure|homes?\s+destroyed|airport\s+closed)\b/i;
const EXPLOSIVE = /\b(?:political\s+violence|assassinat(?:ion|ed)|election\s+(?:violence|unrest)|emergency\s+(?:declaration|rule)|state\s+of\s+emergency)\b/i;

/** Whether a general-news RSS article reports a concrete security/disaster event. */
export function isOsintRelevant(title: string, description = ''): boolean {
  const heading = title.trim();
  if (!heading) return false;
  if (INCIDENT.test(heading) || CYBER.test(heading) || EXPLOSIVE.test(heading)) return true;
  // Do not turn ordinary weather forecasts into OSINT: require an impact.
  if (DISASTER.test(heading) && IMPACT.test(heading + ' ' + description)) return true;
  // An understated headline can still identify a known incident in its summary,
  // but only when the headline has a clear geography/security context.
  const context = /\b(?:ukraine|russia|israel|gaza|iran|syria|lebanon|yemen|sudan|taiwan|nato|military|border|security|defen[cs]e)\b/i;
  return context.test(heading) && (INCIDENT.test(description) || CYBER.test(description));
}
