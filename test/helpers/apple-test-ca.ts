/**
 * A throwaway certificate authority shaped like Apple's, for testing real JWS verification.
 *
 * Apple's `SignedDataVerifier` is the security boundary of this package, and the only way to
 * exercise it honestly is to give it a chain it will actually validate. `Environment.LOCAL_TESTING`
 * skips signature and chain verification by design, so tests that use it prove nothing about
 * either.
 *
 * The chain here satisfies every check the verifier makes:
 *
 *   1. `x5c` carries exactly three certificates: leaf, intermediate, root.
 *   2. The intermediate is signed by the root and its issuer matches the root's subject.
 *   3. The leaf is signed by the intermediate and its issuer matches the intermediate's subject.
 *   4. The intermediate is a CA.
 *   5. The leaf carries Apple's leaf OID `1.2.840.113635.100.6.11.1`.
 *   6. The intermediate carries Apple's OID `1.2.840.113635.100.6.2.1`.
 *   7. All three are valid at the payload's `signedDate`, which is the effective date offline.
 *   8. The JWS is ES256-signed by the leaf's key.
 *
 * These are Apple's rules, read out of the SDK's `verifyCertificateChainWithoutCaching`. If Apple
 * changes them, these tests fail, which is the point.
 */
import { KJUR, KEYUTIL, type KJUR as KJURTypes } from "jsrsasign"

/** Apple's Worldwide Developer Relations intermediate marker. */
const APPLE_INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1"
/** Apple's receipt-signing leaf marker. */
const APPLE_LEAF_OID = "1.2.840.113635.100.6.11.1"
/** DER NULL, which is what these marker extensions carry. */
const DER_NULL = "0500"

// jsrsasign types `generateKeypair` per algorithm; EC keys flow straight back into the
// certificate builder and the JWS signer, so the concrete class is not interesting here.
type TestKey = KJURTypes.crypto.ECDSA
type KeyPair = { prvKeyObj: TestKey; pubKeyObj: TestKey }

export interface AppleTestCertificateAuthority {
  /** The root, PEM-encoded, for `APPLE_ROOT_CERTIFICATES_PEM`. */
  rootCertificatePem: string
  /** Sign a payload into a JWS whose `x5c` carries this chain. */
  sign: (_payload: Record<string, unknown>) => string
}

/* eslint-disable no-unused-vars -- The signature above names its parameter only for typing. */

interface CertificateSpec {
  subject: string
  issuer: string
  subjectKey: TestKey
  issuerKey: TestKey
  serial: number
  ca?: boolean
  markerOid?: string
  notBefore?: string
  notAfter?: string
}

/* eslint-enable no-unused-vars */

/** Wide enough that a fixture's `signedDate` never falls outside it. */
const NOT_BEFORE = "200101000000Z"
const NOT_AFTER = "400101000000Z"

function generateKeyPair(): KeyPair {
  return KEYUTIL.generateKeypair("EC", "secp256r1")
}

function certificatePem(spec: CertificateSpec): string {
  const extensions: { extname: string; [key: string]: unknown }[] = []
  if (spec.ca) extensions.push({ extname: "basicConstraints", cA: true, critical: true })
  if (spec.markerOid) extensions.push({ extname: spec.markerOid, extn: DER_NULL })

  return new KJUR.asn1.x509.Certificate({
    version: 3,
    serial: { int: spec.serial },
    issuer: { str: spec.issuer },
    subject: { str: spec.subject },
    notbefore: spec.notBefore ?? NOT_BEFORE,
    notafter: spec.notAfter ?? NOT_AFTER,
    sbjpubkey: spec.subjectKey,
    ext: extensions,
    sigalg: "SHA256withECDSA",
    cakey: spec.issuerKey
  }).getPEM()
}

function derBase64(pem: string): string {
  return pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "")
}

export interface AppleTestCaOptions {
  /**
   * Sign the leaf with a key the intermediate did not issue, keeping the chain otherwise intact.
   * Used to prove the verifier actually checks the signature rather than the shape.
   */
  untrustedLeaf?: boolean
  /** Omit Apple's marker OID from the leaf. */
  omitLeafMarkerOid?: boolean
  /** Issue the leaf already expired, to exercise the date check. */
  expiredLeaf?: boolean
}

export function createAppleTestCertificateAuthority(
  options: AppleTestCaOptions = {}
): AppleTestCertificateAuthority {
  const root = generateKeyPair()
  const intermediate = generateKeyPair()
  const leaf = generateKeyPair()
  const impostor = generateKeyPair()

  const rootSubject = "/CN=StoreKit Test Root CA"
  const intermediateSubject = "/CN=StoreKit Test Intermediate CA"

  const rootPem = certificatePem({
    subject: rootSubject,
    issuer: rootSubject,
    subjectKey: root.pubKeyObj,
    issuerKey: root.prvKeyObj,
    serial: 1,
    ca: true
  })
  const intermediatePem = certificatePem({
    subject: intermediateSubject,
    issuer: rootSubject,
    subjectKey: intermediate.pubKeyObj,
    issuerKey: root.prvKeyObj,
    serial: 2,
    ca: true,
    markerOid: APPLE_INTERMEDIATE_OID
  })
  const leafPem = certificatePem({
    subject: "/CN=StoreKit Test Leaf",
    issuer: intermediateSubject,
    subjectKey: leaf.pubKeyObj,
    // Signing with a key the intermediate does not own leaves every name matching and only the
    // signature wrong, which is exactly the forgery the chain check exists to catch.
    issuerKey: options.untrustedLeaf ? impostor.prvKeyObj : intermediate.prvKeyObj,
    serial: 3,
    ...(options.omitLeafMarkerOid ? {} : { markerOid: APPLE_LEAF_OID }),
    ...(options.expiredLeaf ? { notBefore: "200101000000Z", notAfter: "210101000000Z" } : {})
  })

  const chain = [leafPem, intermediatePem, rootPem].map(derBase64)

  return {
    rootCertificatePem: rootPem,
    sign(payload) {
      return KJUR.jws.JWS.sign(
        "ES256",
        JSON.stringify({ alg: "ES256", x5c: chain }),
        JSON.stringify(payload),
        leaf.prvKeyObj
      )
    }
  }
}
