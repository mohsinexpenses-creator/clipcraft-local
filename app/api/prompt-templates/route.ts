import { NextResponse } from 'next/server';
import { getPromptTemplate, listPromptTemplates, savePromptTemplate } from '@/lib/db';
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
