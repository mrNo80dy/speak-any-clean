"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type HudTimers = {
  top?: number;
  br?: number;
  pip?: number;
};

const TOP_IDLE_MS = 8000;
const BR_IDLE_MS = 8000;
const AFTER_INTERACTION_MS = 3000;

export function useHudController() {
  const [topVisible, setTopVisible] = useState(true);
  const [brVisible, setBrVisible] = useState(true);
  const [pipControlsVisible, setPipControlsVisible] = useState(false);
  const [pipPinned, setPipPinned] = useState(false);

  const timersRef = useRef<HudTimers>({});

  const clearTimer = (key: keyof HudTimers) => {
    const t = timersRef.current[key];
    if (t) {
      window.clearTimeout(t);
      delete timersRef.current[key];
    }
  };

  const startTimer = (key: keyof HudTimers, ms: number, hide: () => void) => {
    clearTimer(key);
    timersRef.current[key] = window.setTimeout(hide, ms);
  };

  /* =========================
     TOP HUD
     ========================= */

  const wakeTopHud = useCallback((short = false) => {
    setTopVisible(true);
    startTimer(
      "top",
      short ? AFTER_INTERACTION_MS : TOP_IDLE_MS,
      () => setTopVisible(false)
    );
  }, []);

  /* =========================
     BOTTOM-RIGHT HUD
     ========================= */

  const wakeBrHud = useCallback((short = false) => {
    setBrVisible(true);
    startTimer(
      "br",
      short ? AFTER_INTERACTION_MS : BR_IDLE_MS,
      () => setBrVisible(false)
    );
  }, []);

  /* =========================
     PiP CONTROLS
     ========================= */

  const wakePipControls = useCallback((short = false) => {
    if (pipPinned) return;
    setPipControlsVisible(true);
    startTimer(
      "pip",
      short ? AFTER_INTERACTION_MS : BR_IDLE_MS,
      () => setPipControlsVisible(false)
    );
  }, [pipPinned]);

  const togglePipPinned = useCallback(() => {
    setPipPinned((p) => {
      if (!p) {
        clearTimer("pip");
        setPipControlsVisible(true);
      }
      return !p;
    });
  }, []);

  /* =========================
     GLOBAL CLEANUP
     ========================= */

  useEffect(() => {
    return () => {
      Object.values(timersRef.current).forEach((t) => {
        if (t) window.clearTimeout(t);
      });
      timersRef.current = {};
    };
  }, []);

  return {
    /* visibility */
    topVisible,
    brVisible,
    pipControlsVisible,
    pipPinned,

    /* wake functions */
    wakeTopHud,
    wakeBrHud,
    wakePipControls,

    /* pip pin */
    togglePipPinned,
  };
}
