import { createRoot } from 'react-dom/client';
import { ResolutionWorkspace } from '@/components/resolution/ResolutionWorkspace';
import { ReviewedValuesPanel } from '@/components/documents/ReviewedValuesPanel';

createRoot(document.getElementById('root')!).render(<>
  <p>Local synthetic fixture. In-memory transport only; no provider, customer data, or production database.</p>
  {location.pathname === '/reviewed'
    ? <ReviewedValuesPanel documentId="11111111-1111-4111-8111-111111111111" projectId="fixture-project" />
    : <ResolutionWorkspace projectId="fixture-project" link={{}} />}
</>);
