/**
 * GeminiAmbientService
 * Gemini Live (BidiGenerateContent) client for the ambient assistant.
 *
 * Deliberately separate from GeminiLiveService (the standup flow's
 * client), even though the wire protocol is identical — this class has no
 * MeetingStateService dependency, a caller-supplied system prompt, and a
 * generic function-calling surface instead of a hardcoded
 * update_standup_data tool.
 *
 * Runs in AUDIO response modality, same as the standup flow — per the
 * explicit decision to void the TTS dependency and rely on the system
 * prompt alone to keep the bot silent when not addressed. See §5 of
 * AMBIENT_BOT_ARCHITECTURE_PLAN.md for the accepted tradeoff this implies.
 */

import WebSocket from 'ws';
import { config } from '../config/index.js';

const GEMINI_WS_URL =
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${config.geminiApiKey}`;

export interface AmbientFunctionDeclaration {
  name: string;
  description: string;
  parameters: object;
}

export interface AmbientFunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

type AudioChunkCb = (chunk: string) => void;
/** Fires on turnComplete — whether or not the model actually produced
 *  audio this turn. An empty turn (prompt-gated silence working as
 *  intended) still reaches this callback with no prior onAudioChunk call. */
type AudioDoneCb = () => void;
type TranscriptCb = (role: 'user' | 'assistant', text: string) => void;
type FunctionCallCb = (call: AmbientFunctionCall) => void;
type ErrorCb = (msg: string) => void;

export class GeminiAmbientService {
  private ws: WebSocket | null = null;
  private ready = false;
  private inputTranscriptBuf = '';
  private outputTranscriptBuf = '';

  constructor(
    private readonly systemPrompt: string,
    /** Empty when no task actions are registered — Phase D passes
     *  AMBIENT_TASK_TOOLS here. This class doesn't need to change. */
    private readonly functionDeclarations: AmbientFunctionDeclaration[],
    private readonly cb: {
      onAudioChunk: AudioChunkCb;
      onAudioDone: AudioDoneCb;
      onTranscript: TranscriptCb;
      onFunctionCall: FunctionCallCb;
      onError: ErrorCb;
    }
  ) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(GEMINI_WS_URL);

      this.ws.on('open', () => this.sendSetup());

      this.ws.on('message', (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString()) as GeminiServerMsg;
          this.handleMessage(msg, resolve);
        } catch (e) {
          console.error('[GeminiAmbient] Parse error', e);
        }
      });

      this.ws.on('error', (err) => {
        console.error('[GeminiAmbient] WS error', err.message);
        this.ready = false;
        this.cb.onError(err.message);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[GeminiAmbient] WS closed ${code} ${reason.toString()}`);
        this.ready = false;
      });
    });
  }

  /** Send PCM16 16kHz mono audio (base64) — identical wire format to GeminiLiveService. */
  sendAudio(base64: string): void {
    if (!this.ready) return;
    this.send({ realtimeInput: { audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } } });
  }

  /** Silent context injection — e.g. "the current speaker is now X." Same
   *  realtimeInput.text pattern GeminiLiveService uses for turn handoffs,
   *  for the same reason: Gemini Live doesn't support mid-session
   *  config/history updates the way some other realtime APIs do. */
  sendSystemHint(text: string): void {
    if (!this.ready) return;
    this.send({ realtimeInput: { text } });
  }

  respondToFunctionCall(callId: string, name: string, response: Record<string, unknown>): void {
    this.send({ toolResponse: { functionResponses: [{ id: callId, name, response }] } });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.ready = false;
  }

  get connected(): boolean {
    return this.ready;
  }

  private sendSetup(): void {
    const setup: GeminiSetup = {
      setup: {
        model: `models/${config.geminiModel}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } },
          // Lower than the standup flow's 0.75 — ambient responses lean
          // conservative on purpose, since prompt-gated silence is doing
          // real work here (§5 of the architecture plan) and a more
          // liberal temperature makes "should I speak?" less predictable.
          temperature: 0.6,
        },
        systemInstruction: { parts: [{ text: this.systemPrompt }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: { disabled: false, silenceDurationMs: 500, prefixPaddingMs: 100 },
        },
        ...(this.functionDeclarations.length
          ? { tools: [{ functionDeclarations: this.functionDeclarations }] }
          : {}),
      },
    };
    this.send(setup);
  }

  private handleMessage(msg: GeminiServerMsg, resolveConnect?: (v: void) => void): void {
    if ('setupComplete' in msg) {
      console.log('[GeminiAmbient] Setup complete, session ready');
      this.ready = true;
      resolveConnect?.();
      return;
    }

    if ('serverContent' in msg && msg.serverContent) {
      const sc = msg.serverContent;

      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData?.mimeType?.startsWith('audio/') && part.inlineData.data) {
            this.cb.onAudioChunk(part.inlineData.data);
          }
        }
      }

      if (sc.inputTranscription?.text) this.inputTranscriptBuf += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) this.outputTranscriptBuf += sc.outputTranscription.text;

      if (sc.turnComplete) {
        if (this.inputTranscriptBuf.trim()) {
          this.cb.onTranscript('user', this.inputTranscriptBuf.trim());
          this.inputTranscriptBuf = '';
        } else {
          console.log('[GeminiAmbient] turn ended with no input transcription — Gemini did not recognize any speech in the forwarded audio');
        }
        if (this.outputTranscriptBuf.trim()) {
          this.cb.onTranscript('assistant', this.outputTranscriptBuf.trim());
          this.outputTranscriptBuf = '';
        }
        this.cb.onAudioDone();
      }

      if (sc.interrupted) {
        console.log('[GeminiAmbient] generation interrupted mid-turn');
        this.outputTranscriptBuf = '';
        this.cb.onAudioDone();
      }
    }

    if ('toolCall' in msg && msg.toolCall?.functionCalls?.length) {
      for (const fc of msg.toolCall.functionCalls) {
        this.cb.onFunctionCall({ id: fc.id, name: fc.name, args: (fc.args ?? {}) as Record<string, unknown> });
      }
    }
  }

  private send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}

// ── Gemini wire-protocol types (minimal — mirrors GeminiLiveService's) ────────

interface GeminiSetup {
  setup: {
    model: string;
    generationConfig?: {
      responseModalities?: string[];
      speechConfig?: object;
      temperature?: number;
    };
    systemInstruction?: { parts: { text: string }[] };
    inputAudioTranscription?: object;
    outputAudioTranscription?: object;
    realtimeInputConfig?: object;
    tools?: object[];
  };
}

interface GeminiServerMsg {
  setupComplete?: object;
  serverContent?: {
    modelTurn?: { parts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> };
    inputTranscription?: { text: string };
    outputTranscription?: { text: string };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  toolCall?: { functionCalls?: Array<{ id: string; name: string; args: unknown }> };
}
