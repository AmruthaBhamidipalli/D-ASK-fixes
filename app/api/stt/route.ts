import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '../../../lib/security/apiAuth';

// Speech-to-text is OFFLINE ONLY and is served by the native HUD (src/hud-native: dask://localhost/api/stt -> whisper.cpp,
// with the Windows recognizer as the local fallback). This Next.js route exists only so a browser/dev build answers clearly
// instead of 404. It never forwards audio anywhere: the former hosted (Groq) path was removed on 2026-11-16 because it was a
// dead end in offline-first mode and suggested a cloud recognizer that D-ASK must not depend on.
export async function POST(req: NextRequest) {
  const denied = requireAuth(req, 'task');
  if (denied) return denied;
  try {
    const formData = await req.formData().catch(() => null);
    const file = formData?.get('file') as Blob | null | undefined;
    if (!file) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }
    return NextResponse.json(
      {
        error: 'Speech-to-text runs only in the native D-ASK HUD (offline whisper.cpp). This development server does not transcribe audio and never sends it to a cloud service.',
        reason: 'native HUD required for offline speech recognition',
        unavailable: 'native-hud-required',
      },
      { status: 503 }
    );
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
