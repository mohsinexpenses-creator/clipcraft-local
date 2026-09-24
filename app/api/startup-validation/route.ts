import { NextResponse } from 'next/server';
import { toErrorMessage } from '@/lib/errors';
import { runStartupValidation } from '@/lib/startup-validation';

export async function GET() {
  try {
    const result = await runStartupValidation();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to run startup validation.') },
      { status: 500 }
    );
  }
}
