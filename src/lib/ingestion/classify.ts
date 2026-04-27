import Anthropic from '@anthropic-ai/sdk';
import { INGESTION_CONFIG } from './config';
import type { ZoomParticipant } from '@/lib/zoom/client';

export interface TranscriptClassification {
  meetingType:
    | 'coaching_1on1'
    | 'coaching_group'
    | 'kickoff'
    | 'internal_team'
    | 'coach_onboarding'
    | 'external'
    | 'scheduling_only'
    | 'test_or_discard';
  sessionPhase: 'kickoff' | 'regular' | 'reset' | 'follow_up' | 'final' | null;
  durationBucket: 'short' | 'standard' | 'deep_dive';
  frameworkAreasCovered: string[];
  commitmentDensity: number;
  includeInMonthlySummary: boolean;
  includeReason: string;
  participantsSummary: string;
}

const SYSTEM_PROMPT = `You are a classifier for executive coaching session transcripts. You receive Zoom meeting metadata + a transcript excerpt and produce structured JSON about what kind of meeting this is and whether it should feed into a CEO's monthly coaching summary.

Output ONLY a JSON object with these exact keys (no markdown, no explanation):

{
  "meetingType": "coaching_1on1" | "coaching_group" | "kickoff" | "internal_team" | "coach_onboarding" | "external" | "scheduling_only" | "test_or_discard",
  "sessionPhase": "kickoff" | "regular" | "reset" | "follow_up" | "final" | null,
  "durationBucket": "short" | "standard" | "deep_dive",
  "frameworkAreasCovered": [...],   // subset of: "10x_goal", "constraints", "mindset", "strategy", "talent", "execution", "leverage", "self_management"
  "commitmentDensity": 0-10,         // rough count of concrete commitments / next-actions surfaced
  "includeInMonthlySummary": true | false,
  "includeReason": "one short sentence",
  "participantsSummary": "Eric Partaker (coach) + Dave Dieter (CEO)"
}

Rules:
- meetingType "internal_team" / "coach_onboarding" / "scheduling_only" / "test_or_discard" / "external" → includeInMonthlySummary MUST be false.
- "coaching_1on1" / "coaching_group" / "kickoff" with substantive coaching content → includeInMonthlySummary true.
- durationBucket: short = <30 min, standard = 30-90, deep_dive = >90.
- Be conservative: if the call is mostly logistics/scheduling/tech issues with no coaching content, set includeInMonthlySummary false.`;

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n\n[…transcript truncated…]';
}

function safeParse(raw: string): TranscriptClassification | null {
  // Strip markdown fences if any
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as TranscriptClassification;
  } catch {
    // Try to extract the first JSON object from the string
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as TranscriptClassification;
    } catch {
      return null;
    }
  }
}

export async function classifyTranscript(args: {
  topic: string;
  participants: ZoomParticipant[];
  duration: number;
  transcriptText: string;
}): Promise<TranscriptClassification> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const client = new Anthropic({ apiKey });

  const participantLines = args.participants
    .map((p) => {
      const role = p.internal_user ? '(internal/coach)' : '(external)';
      const email = p.user_email ? ` <${p.user_email}>` : '';
      return `- ${p.name}${email} ${role}`;
    })
    .join('\n');

  const userPrompt = `Meeting topic: ${args.topic}
Duration: ${args.duration} minutes
Participants:
${participantLines || '(none)'}

Transcript:
---
${truncate(args.transcriptText, 24_000)}
---

Classify this meeting now. Output JSON only.`;

  const response = await client.messages.create({
    model: INGESTION_CONFIG.classifierModel,
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const parsed = safeParse(text);
  if (!parsed) {
    // Fail safe: mark as needing classification rather than silently dropping
    return {
      meetingType: 'test_or_discard',
      sessionPhase: null,
      durationBucket: args.duration < 30 ? 'short' : args.duration <= 90 ? 'standard' : 'deep_dive',
      frameworkAreasCovered: [],
      commitmentDensity: 0,
      includeInMonthlySummary: false,
      includeReason: 'Classifier returned unparseable output',
      participantsSummary: args.participants.map((p) => p.name).join(', '),
    };
  }

  return parsed;
}
