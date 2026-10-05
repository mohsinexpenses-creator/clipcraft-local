'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';

interface StartupCheck {
  id: string;
  label: string;
  status: 'ok' | 'warning' | 'error';
  summary: string;
  details?: string;
  resolution?: string;
}

interface StartupValidationResponse {
  ready: boolean;
  generatedAt: string;
  checks: StartupCheck[];
}

async function getErrorFromResponse(response: Response, fallback: string) {
  try {
    const data = await response.json();
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

function StatusBadge({ status }: { status: StartupCheck['status'] }) {
  switch (status) {
    case 'ok':
      return (
        <Badge variant="success">
          <CheckCircle2 />
          Ready
        </Badge>
      );
    case 'warning':
      return (
        <Badge variant="secondary">
          <ShieldAlert />
          Warning
        </Badge>
      );
    default:
      return (
        <Badge variant="destructive">
          <AlertCircle />
          Error
        </Badge>
      );
  }
}

export default function StartupValidationPage() {
  const [result, setResult] = useState<StartupValidationResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadValidation = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/startup-validation');
      if (!res.ok) {
        throw new Error(await getErrorFromResponse(res, 'Failed to run startup validation.'));
      }

      const data = (await res.json()) as StartupValidationResponse;
      setResult(data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to run startup validation.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;

    (async () => {
      try {
        const res = await fetch('/api/startup-validation');
        if (!res.ok) {
          throw new Error(await getErrorFromResponse(res, 'Failed to run startup validation.'));
        }

        const data = (await res.json()) as StartupValidationResponse;
        if (!ignore) {
          setResult(data);
          setErrorMessage(null);
        }
      } catch (error) {
        if (!ignore) {
          setErrorMessage(
            error instanceof Error ? error.message : 'Failed to run startup validation.'
          );
        }
      } finally {
        if (!ignore) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      ignore = true;
    };
  }, []);

  return (
    <div className="space-y-8">
      <div className="flex animate-fade-up flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Startup validation</h1>
          <p className="text-sm text-muted-foreground">
            Verify SQLite storage, transcription, FFmpeg, and AI provider setup before you start processing videos.
          </p>
        </div>
        <Button onClick={loadValidation} disabled={isLoading}>
          {isLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Refresh checks
        </Button>
      </div>

      {errorMessage && (
        <Alert variant="destructive">
          <AlertCircle className="mt-0.5" />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {isLoading && !result ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : result ? (
        <>
          <Card className="animate-fade-up">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                {result.ready ? (
                  <ShieldCheck className="size-4 text-primary" />
                ) : (
                  <ShieldAlert className="size-4 text-destructive" />
                )}
                Overall startup status
              </CardTitle>
              <CardDescription>
                Last checked {new Date(result.generatedAt).toLocaleString()}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              <Badge variant={result.ready ? 'success' : 'destructive'}>
                {result.ready ? 'Ready to process' : 'Action required'}
              </Badge>
              <p className="text-sm text-muted-foreground">
                {result.ready
                  ? 'Core dependencies are configured. You can upload, transcribe, analyze, and render clips.'
                  : 'At least one required dependency is missing or failing. Fix the red checks below first.'}
              </p>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {result.checks.map((check) => (
              <Card key={check.id} className="animate-fade-up gap-4">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">{check.label}</CardTitle>
                      <CardDescription>{check.summary}</CardDescription>
                    </div>
                    <StatusBadge status={check.status} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {check.details && (
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Details
                      </p>
                      <p className="rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs leading-relaxed text-foreground/80">
                        {check.details}
                      </p>
                    </div>
                  )}

                  {check.resolution && (
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        How to fix
                      </p>
                      <p className="rounded-lg border border-dashed px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                        {check.resolution}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
