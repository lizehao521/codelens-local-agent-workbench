// 能力面板宿主——所有治理类弹层只在这里挂载一次。
// 左导航与右栏只写 uiStore.activeModal，避免同一面板被挂两遍、状态各一份。

import { useEffect } from 'react';
import { JudgePanelModal } from '../agent/JudgePanelModal';
import { RsiDashboardModal } from '../agent/RsiDashboardModal';
import { RsiIterationGate } from '../agent/RsiIterationGate';
import { SandboxPermissionModal } from '../settings/SandboxPermissionModal';
import { ToolSkillModal } from './ToolSkillModal';
import { Modal } from '../common/Modal';
import { useServerSessionStore } from '../../stores/serverSessionStore';
import { useUiStore } from '../../stores/uiStore';

/** URL 直达：?rsi=1&session=<id> 打开即展开 RSI 读数（交接 / 演示用）。 */
function readDeepLink(): { rsi: boolean; sessionId: string | null } {
  if (typeof window === 'undefined') return { rsi: false, sessionId: null };
  const params = new URLSearchParams(window.location.search);
  return { rsi: params.get('rsi') === '1', sessionId: params.get('session') };
}

export function CapabilityHost() {
  const activeModal = useUiStore((s) => s.activeModal);
  const openCapability = useUiStore((s) => s.openCapability);
  const closeCapability = useUiStore((s) => s.closeCapability);
  const activeSessionId = useServerSessionStore((s) => s.activeSessionId);

  useEffect(() => {
    if (readDeepLink().rsi) openCapability('rsi');
  }, [openCapability]);

  const sessionId = readDeepLink().sessionId ?? activeSessionId;

  return (
    <>
      <JudgePanelModal open={activeModal === 'judge'} onClose={closeCapability} />
      <RsiDashboardModal open={activeModal === 'rsi'} onClose={closeCapability} sessionId={sessionId} />
      <SandboxPermissionModal open={activeModal === 'sandbox'} onClose={closeCapability} />
      <ToolSkillModal open={activeModal === 'skills'} onClose={closeCapability} />
      <Modal
        open={activeModal === 'iteration'}
        onClose={closeCapability}
        title="自我迭代闸门"
        maxWidth={880}
      >
        <RsiIterationGate />
      </Modal>
    </>
  );
}
