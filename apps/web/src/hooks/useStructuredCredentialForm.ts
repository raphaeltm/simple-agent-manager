import type { CreateCredentialRequest } from '@simple-agent-manager/shared';
import { useState } from 'react';

import { createCredential, deleteCredential } from '../lib/api';
import { useToast } from './useToast';

interface StructuredCredentialFormOptions {
  provider: CreateCredentialRequest['provider'];
  title: string;
  hasCredential: boolean;
  onUpdate: () => void;
}

export function useStructuredCredentialForm({
  provider,
  title,
  hasCredential,
  onUpdate,
}: StructuredCredentialFormOptions) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const clearMessages = () => {
    setValidationMessage(null);
    setError(null);
  };

  const save = async (request: CreateCredentialRequest, resetFields: () => void) => {
    setLoading(true);
    clearMessages();
    try {
      const result = await createCredential(request);
      if (result.validation?.valid === false) {
        setError(`Saved, but ${result.validation.error ?? result.validation.message}`);
        toast.warning(`${title} credentials saved with a validation warning`);
        onUpdate();
        return;
      }
      setValidationMessage(result.validation?.message ?? `${title} credential validated.`);
      toast.success(`${title} credentials saved`);
      resetFields();
      setShowForm(false);
      onUpdate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save credentials');
    } finally {
      setLoading(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Are you sure you want to disconnect your ${title} account?`)) return;
    setLoading(true);
    setError(null);
    try {
      await deleteCredential(provider);
      toast.success(`${title} account disconnected`);
      onUpdate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to delete credentials');
    } finally {
      setLoading(false);
    }
  };

  let submitLabel = 'Connect';
  if (hasCredential) submitLabel = 'Update Credentials';
  if (loading) submitLabel = 'Testing...';

  return {
    loading,
    validationMessage,
    error,
    showForm,
    setShowForm,
    clearMessages,
    save,
    remove,
    submitLabel,
  };
}
