import type { OnboardingCase } from '../api/types';
import { humanize } from '../format';
import { Badge } from './Badge';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{children ?? '—'}</dd>
    </div>
  );
}

export function CaseDetails({ data }: { data: OnboardingCase }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>
          {data.id} · {data.customerFullName}
        </h2>
        <span className="synthetic-tag">Synthetic data</span>
      </div>

      <div className="detail-grid">
        <div>
          <h3>Customer profile</h3>
          <dl>
            <Field label="Full name">{data.customerFullName}</Field>
            <Field label="Date of birth">{data.dateOfBirth}</Field>
            <Field label="Nationality">{data.nationality}</Field>
            <Field label="Product">{humanize(data.productType)}</Field>
            <Field label="Case status"><Badge value={data.caseStatus} /></Field>
          </dl>
        </div>
        <div>
          <h3>Identity and address</h3>
          <dl>
            <Field label="Residential address">{data.residentialAddress}</Field>
            <Field label="Identity verification (as recorded)">
              <Badge value={data.identityVerificationStatus} />
            </Field>
          </dl>
          <h3>Employment</h3>
          <dl>
            <Field label="Occupation">{data.occupation}</Field>
            <Field label="Declared annual income">
              {data.declaredAnnualIncome === null ? null : data.declaredAnnualIncome.toLocaleString()}
            </Field>
          </dl>
        </div>
      </div>

      <h3>Supporting documents</h3>
      <p className="muted small">Metadata only. "Provided" does not mean a document has been authenticated.</p>
      {data.documents.length === 0 ? (
        <p className="muted">No documents submitted.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Type</th><th>Subtype</th><th>Reference</th><th>Name on document</th>
                <th>Address / DOB on document</th><th>Issued</th><th>Expires</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.documents.map((d) => (
                <tr key={d.id}>
                  <td>{humanize(d.documentType)}</td>
                  <td>{humanize(d.documentSubtype)}</td>
                  <td className="mono">{d.documentReference}</td>
                  <td>{d.nameOnDocument}</td>
                  <td>{d.addressOnDocument ?? d.dateOfBirthOnDocument ?? '—'}</td>
                  <td>{d.issueDate ?? '—'}</td>
                  <td>{d.expiryDate ?? '—'}</td>
                  <td><Badge value={d.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Risk indicators (predefined, synthetic)</h3>
      {data.riskIndicators.length === 0 ? (
        <p className="muted">No risk indicators recorded.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Code</th><th>Severity</th><th>Status</th><th>Description</th></tr>
            </thead>
            <tbody>
              {data.riskIndicators.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.code}</td>
                  <td><Badge value={r.severity} /></td>
                  <td><Badge value={r.status} /></td>
                  <td>{r.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
