import { NextResponse } from 'next/server';
import {
  getPromptTemplate,
  listPromptTemplates,
  resetPromptTemplates,
  savePromptTemplate,
} from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type');

    if (type) {
      const template = await getPromptTemplate(type);
      return NextResponse.json({ template });
    }

    const templates = await listPromptTemplates();
    return NextResponse.json({ templates });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to load prompt templates.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

/**
 * POST with `{ "action": "reset" }` restores the shipped default prompt
 * templates (e.g. after an app update brings a new built-in viral prompt).
 * User-edited values for the built-in templates are overwritten.
 */
export async function POST(request: Request) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // fall through - the action check below rejects an empty body
    }

    if (body.action !== 'reset') {
      return NextResponse.json(
        { error: 'Unsupported action. Send { "action": "reset" } to restore default prompt templates.' },
        { status: 400 }
      );
    }

    const templates = await resetPromptTemplates();
    return NextResponse.json({ success: true, templates });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to reset prompt templates.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { _id, type, name, description, systemPrompt, template } = body;

    if (!_id || !type) {
      return NextResponse.json({ error: 'Missing template _id or type' }, { status: 400 });
    }

    const updated = await savePromptTemplate({
      _id,
      type,
      name: name || 'Prompt Template',
      description: description || '',
      systemPrompt: systemPrompt || '',
      template: template || '',
      updatedAt: new Date().toISOString(),
    });

    return NextResponse.json({ success: true, template: updated });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to update prompt template.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
