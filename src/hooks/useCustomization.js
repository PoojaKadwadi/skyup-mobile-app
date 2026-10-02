// src/hooks/useCustomization.js — live company customization for screens.
import { useEffect, useState } from 'react';
import { getCustomization, subscribeCustomization, loadCustomization } from '../services/customizationService';

export default function useCustomization() {
  const [c, setC] = useState(getCustomization());
  useEffect(() => {
    const off = subscribeCustomization(setC);
    loadCustomization();
    return off;
  }, []);
  return c;
}
