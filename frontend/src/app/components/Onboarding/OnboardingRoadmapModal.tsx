// Full 10-step roadmap. Modal opens from the panel's "See all todos" link.
// Stages cascade: Stage 2 unlocks once Stage 1 is fully complete.

import React from 'react';
import { Modal, Box, Typography, IconButton, Button } from '@mui/material';
import { motion, AnimatePresence } from 'framer-motion';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import LockIcon from '@mui/icons-material/Lock';
import CloseIcon from '@mui/icons-material/Close';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useOnboardingProgress } from './hooks/useOnboardingProgress';
import { STAGE_GROUPS, STEPS, findStepById } from './steps';
import { STAGE_LABELS } from './steps/types';
import { onboardingDirector } from './OnboardingDirector';
import { report } from './telemetry';

const OnboardingRoadmapModal: React.FC = () => {
  const c = useClaudeTokens();
  const progress = useOnboardingProgress();
  const open = progress.panelMode === 'roadmap';
  const close = () => progress.setPanelMode('expanded');

  const stage1Done = STAGE_GROUPS[0].steps.every((s) =>
    progress.completedSteps.includes(s.id),
  );

  const currentStep = progress.currentStepId
    ? findStepById(progress.currentStepId)
    : STEPS.find((s) => !progress.completedSteps.includes(s.id));

  const totalDone = progress.completedSteps.length;
  const total = STEPS.length;

  const jumpToCurrent = () => {
    if (currentStep) progress.setCurrentStep(currentStep.id);
    progress.setPanelMode('expanded');
  };

  // Anchor the roadmap to the same top-right corner the panel sits in,
  // so visually it reads as the panel "expanding into" the full roadmap
  // rather than a centered modal that breaks spatial continuity. The
  // origin point matches OnboardingPanel's top:44 / right:16 dock.
  return (
    <Modal
      open={open}
      onClose={close}
      // Disable Modal's internal flex centering — we position the inner
      // box absolutely from the top-right corner ourselves.
      sx={{ inset: 0 }}
      slotProps={{
        backdrop: {
          sx: { backgroundColor: 'rgba(0,0,0,0.42)' },
        },
      }}
      // Modal mounts as soon as `open` is true; AnimatePresence inside
      // owns the actual exit animation, so we keep keepMounted off and
      // use AnimatePresence with mode="wait".
    >
      {/* Outer Box gets focus / aria attributes from MUI Modal. The
          motion.div inside handles the slide-in. */}
      <Box
        sx={{
          position: 'absolute',
          top: 44,
          right: 16,
          outline: 'none',
        }}
      >
      <AnimatePresence>
        {open && (
        <motion.div
          key="onboarding-roadmap"
          initial={{ opacity: 0, y: -10, scale: 0.94, transformOrigin: 'top right' }}
          animate={{ opacity: 1, y: 0, scale: 1, transformOrigin: 'top right' }}
          exit={{ opacity: 0, y: -8, scale: 0.96, transformOrigin: 'top right' }}
          transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          style={{ outline: 'none' }}
        >
      <Box
        sx={{
          // Roughly the same width as the expanded panel, just a touch
          // wider so the 8-row roadmap breathes. 360 vs panel's 320.
          width: 360,
          maxHeight: 'calc(100vh - 80px)',
          overflowY: 'auto',
          bgcolor: c.bg.surface,
          color: c.text.primary,
          border: `1px solid ${c.border.medium}`,
          borderRadius: `${c.radius.lg}px`,
          boxShadow: '0 14px 40px rgba(0,0,0,0.28)',
          outline: 'none',
          fontFamily: c.font.sans,
        }}
      >
        {/* Header */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 2.4,
            pt: 1.8,
            pb: 1.2,
            borderBottom: `1px solid ${c.border.subtle}`,
          }}
        >
          <Box>
            <Typography
              sx={{
                fontSize: 16,
                fontWeight: 600,
                fontFamily: '"Charter", Georgia, serif',
              }}
            >
              Your roadmap
            </Typography>
            <Typography sx={{ fontSize: 12, color: c.text.muted, mt: 0.2 }}>
              {totalDone}/{total} milestones reached
            </Typography>
          </Box>
          <IconButton
            size="small"
            onClick={close}
            sx={{ color: c.text.tertiary }}
            aria-label="Close roadmap"
          >
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>

        {/* Stages */}
        <Box sx={{ px: 2.4, pt: 1.6, pb: 0.5 }}>
          {STAGE_GROUPS.map((group, gi) => {
            const stageDone = group.steps.filter((s) =>
              progress.completedSteps.includes(s.id),
            ).length;
            const isLocked = gi === 1 && !stage1Done;
            const isInProgress = !isLocked && stageDone < group.steps.length;
            const stageLabel = isLocked
              ? 'LOCKED'
              : isInProgress
                ? 'IN PROGRESS'
                : 'COMPLETE';
            return (
              <Box key={group.stage} sx={{ mb: 2 }}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    mb: 0.5,
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                    <Typography
                      sx={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        color: isLocked
                          ? c.text.tertiary
                          : isInProgress
                            ? c.accent.primary
                            : c.text.secondary,
                      }}
                    >
                      STAGE {gi + 1} · {stageLabel}
                    </Typography>
                  </Box>
                  <Typography sx={{ fontSize: 11, color: c.text.muted }}>
                    {stageDone}/{group.steps.length}
                  </Typography>
                </Box>
                <Typography
                  sx={{
                    fontSize: 14,
                    fontWeight: 600,
                    mb: 0.8,
                    color: isLocked ? c.text.tertiary : c.text.primary,
                  }}
                >
                  {STAGE_LABELS[group.stage]}
                </Typography>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.6 }}>
                  {group.steps.map((step) => {
                    const isDone = progress.completedSteps.includes(step.id);
                    const isCurrent = currentStep?.id === step.id && !isDone;
                    return (
                      <Box
                        key={step.id}
                        onClick={() => {
                          if (isLocked) return;
                          // If a step is mid-flow, abort it before
                          // jumping. Otherwise the AC keeps animating
                          // for a step the user no longer sees.
                          if (progress.running) {
                            onboardingDirector.cancelStep();
                          }
                          report('roadmap_step_clicked', {
                            step_id: step.id,
                            from_step_id: progress.currentStepId,
                          });
                          progress.setCurrentStep(step.id);
                          progress.setPanelMode('expanded');
                        }}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                          py: 0.45,
                          px: 0.4,
                          borderRadius: `${c.radius.sm}px`,
                          cursor: isLocked ? 'default' : 'pointer',
                          opacity: isLocked ? 0.55 : 1,
                          transition: 'background 0.12s',
                          '&:hover': isLocked
                            ? {}
                            : { bgcolor: c.bg.secondary },
                        }}
                      >
                        {isLocked ? (
                          <LockIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
                        ) : isDone ? (
                          <CheckCircleIcon
                            sx={{ fontSize: 17, color: c.accent.primary }}
                          />
                        ) : (
                          <RadioButtonUncheckedIcon
                            sx={{
                              fontSize: 17,
                              color: isCurrent
                                ? c.accent.primary
                                : c.border.medium,
                            }}
                          />
                        )}
                        <Typography
                          sx={{
                            fontSize: 13,
                            fontWeight: isCurrent ? 600 : 500,
                            color: isDone
                              ? c.text.tertiary
                              : c.text.primary,
                            textDecoration: isDone ? 'line-through' : 'none',
                            flexGrow: 1,
                          }}
                        >
                          {step.title}
                        </Typography>
                        {isCurrent && (
                          <Typography
                            sx={{
                              fontSize: 10.5,
                              fontWeight: 700,
                              letterSpacing: '0.05em',
                              color: c.accent.primary,
                              textTransform: 'uppercase',
                            }}
                          >
                            current
                          </Typography>
                        )}
                      </Box>
                    );
                  })}
                </Box>
              </Box>
            );
          })}
        </Box>

        {/* Footer */}
        <Box
          sx={{
            px: 2.4,
            pb: 2,
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <Button
            onClick={jumpToCurrent}
            disabled={!currentStep}
            sx={{
              textTransform: 'none',
              bgcolor: c.accent.primary,
              color: '#fff',
              fontWeight: 600,
              fontSize: 13,
              px: 1.6,
              py: 0.6,
              borderRadius: `${c.radius.md}px`,
              '&:hover': { bgcolor: c.accent.hover ?? c.accent.primary },
            }}
          >
            Jump to current todo
          </Button>
        </Box>
      </Box>
        </motion.div>
        )}
      </AnimatePresence>
      </Box>
    </Modal>
  );
};

export default OnboardingRoadmapModal;
