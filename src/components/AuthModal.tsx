import React, { useState, useEffect, useRef } from 'react';
import { QrCode, Phone, Key, ExternalLink, AlertCircle, Loader2, CheckCircle2, X } from 'lucide-react';
import QRCode from 'qrcode';
import type { TelegramCredentials } from '../types';
import { 
  initTelegramClient, 
  startQRLogin, 
  sendPhoneCode, 
  signInWithPhone,
  submit2FAPassword
} from '../services/telegram';
import { saveStoredCredentials, saveStoredSession, getStoredCredentials } from '../services/db';

interface AuthModalProps {
  onSuccess: () => void;
  onClose?: () => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({ onSuccess, onClose }) => {
  const [step, setStep] = useState<'creds' | 'login'>('creds');
  const [loginMethod, setLoginMethod] = useState<'qr' | 'phone'>('qr');

  // Credentials State
  const [apiId, setApiId] = useState<string>('');
  const [apiHash, setApiHash] = useState<string>('');
  const [credError, setCredError] = useState<string | null>(null);

  // QR Code State
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState<boolean>(false);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrNeeds2FA, setQrNeeds2FA] = useState<boolean>(false);
  const [qr2FAHint, setQr2FAHint] = useState<string>('');
  const [qr2FAPassword, setQr2FAPassword] = useState<string>('');
  const qr2FAResolverRef = useRef<((pass: string) => void) | null>(null);

  // Phone + OTP State
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [phoneCodeHash, setPhoneCodeHash] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState<string>('');
  const [password2FA, setPassword2FA] = useState<string>('');
  const [needs2FA, setNeeds2FA] = useState<boolean>(false);
  const [phoneLoading, setPhoneLoading] = useState<boolean>(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  useEffect(() => {
    async function autoInit() {
      const creds = await getStoredCredentials();
      if (creds && creds.apiId && creds.apiHash) {
        setApiId(creds.apiId.toString());
        setApiHash(creds.apiHash);
        setStep('login');
        setLoginMethod('qr');
        try {
          await initTelegramClient(creds);
          initiateQRLogin();
        } catch (err: any) {
          setQrError(err.message || 'Failed connecting to Telegram.');
        }
      }
    }
    autoInit();
  }, []);

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    const idNum = parseInt(apiId.trim(), 10);
    const hash = apiHash.trim();

    if (isNaN(idNum) || !hash) {
      setCredError('Please provide a valid numeric API ID and API Hash.');
      return;
    }

    setCredError(null);
    const creds: TelegramCredentials = { apiId: idNum, apiHash: hash };
    await saveStoredCredentials(creds);

    try {
      await initTelegramClient(creds);
      setStep('login');
      if (loginMethod === 'qr') {
        initiateQRLogin();
      }
    } catch (err: any) {
      setCredError(err.message || 'Failed to initialize MTProto client.');
    }
  };

  const initiateQRLogin = async () => {
    setQrLoading(true);
    setQrError(null);
    setQrCodeDataUrl(null);
    setQrNeeds2FA(false);

    try {
      const sessionString = await startQRLogin(
        async (qrUrl) => {
          const dataUrl = await QRCode.toDataURL(qrUrl, {
            width: 280,
            margin: 2,
            color: {
              dark: '#000000',
              light: '#ffffff',
            },
          });
          setQrCodeDataUrl(dataUrl);
          setQrLoading(false);
        },
        async (hint?: string) => {
          setQrNeeds2FA(true);
          setQr2FAHint(hint || '');
          setQrLoading(false);
          return new Promise<string>((resolve) => {
            qr2FAResolverRef.current = resolve;
          });
        },
        (err) => {
          setQrError(err.message || 'QR login expired or failed.');
          setQrLoading(false);
        }
      );

      await saveStoredSession({ stringSession: sessionString });
      onSuccess();
    } catch (err: any) {
      setQrError(err.message || 'QR authentication failed.');
      setQrLoading(false);
    }
  };

  const handleQr2FASubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (qr2FAResolverRef.current && qr2FAPassword) {
      setQrLoading(true);
      setQrError(null);
      qr2FAResolverRef.current(qr2FAPassword);
    }
  };

  const handleSendPhoneCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneNumber) return;

    setPhoneLoading(true);
    setPhoneError(null);

    try {
      const hash = await sendPhoneCode(phoneNumber.trim());
      setPhoneCodeHash(hash);
    } catch (err: any) {
      setPhoneError(err.message || 'Failed to send verification code.');
    } finally {
      setPhoneLoading(false);
    }
  };

  const handleVerifyPhoneCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneCodeHash) return;
    if (!needs2FA && !otpCode) return;

    setPhoneLoading(true);
    setPhoneError(null);

    try {
      let sessionString: string;
      if (needs2FA) {
        if (!password2FA) {
          setPhoneError('Please enter your 2-Step Verification password.');
          setPhoneLoading(false);
          return;
        }
        sessionString = await submit2FAPassword(password2FA.trim());
      } else {
        sessionString = await signInWithPhone(
          phoneNumber.trim(),
          phoneCodeHash,
          otpCode.trim(),
          password2FA ? password2FA.trim() : undefined
        );
      }

      await saveStoredSession({
        stringSession: sessionString,
        phoneNumber: phoneNumber.trim(),
      });

      onSuccess();
    } catch (err: any) {
      if (err.message === '2FA_REQUIRED' || err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        setNeeds2FA(true);
        setPhoneError(null);
      } else if (err.errorMessage === 'PASSWORD_HASH_INVALID') {
        setPhoneError('Incorrect 2-Step Verification password. Please try again.');
      } else if (err.errorMessage === 'PHONE_CODE_INVALID') {
        setPhoneError('Invalid verification code. Please check and try again.');
      } else if (err.errorMessage === 'PHONE_CODE_EXPIRED') {
        setPhoneError('Verification code expired. Please request a new code.');
      } else {
        setPhoneError(err.message || 'Invalid code or authentication error.');
      }
    } finally {
      setPhoneLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-3xl animate-fade-in">
      <div className="relative w-full max-w-md bg-[#121214]/95 border border-white/15 rounded-[32px] p-8 shadow-[0_25px_80px_rgba(0,0,0,0.9)] space-y-6">
        {onClose && (
          <button
            onClick={onClose}
            className="absolute top-6 right-6 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 text-white flex items-center justify-center transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex p-3 rounded-2xl bg-white text-black mb-1 shadow-lg">
            <Key className="w-6 h-6" />
          </div>
          <h2 className="text-2xl font-bold text-white tracking-tight">
            {step === 'creds' ? 'Telegram Connection' : 'Sign In to Telegram'}
          </h2>
          <p className="text-xs text-white/60 max-w-xs mx-auto leading-relaxed">
            {step === 'creds'
              ? 'Zero server dependency: Enter your API credentials to stream directly from Telegram data centers.'
              : 'Link your Telegram account to load your video channels and personal categories.'}
          </p>
        </div>

        {/* Step 1: API ID & API Hash Form */}
        {step === 'creds' && (
          <form onSubmit={handleSaveCredentials} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-white/80">Telegram API ID</label>
              <input
                type="text"
                placeholder="e.g. 12345678"
                value={apiId}
                onChange={(e) => setApiId(e.target.value)}
                required
                className="w-full px-4 py-3 rounded-2xl bg-white/10 border border-white/15 focus:border-white text-sm text-white placeholder-white/30 focus:outline-none transition-all shadow-inner"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-white/80">Telegram API Hash</label>
              <input
                type="text"
                placeholder="e.g. 0123456789abcdef0123456789abcdef"
                value={apiHash}
                onChange={(e) => setApiHash(e.target.value)}
                required
                className="w-full px-4 py-3 rounded-2xl bg-white/10 border border-white/15 focus:border-white text-sm text-white placeholder-white/30 focus:outline-none transition-all font-mono shadow-inner"
              />
            </div>

            <div className="p-3.5 rounded-2xl bg-white/5 border border-white/10 flex items-start space-x-2.5 text-xs text-white/70">
              <ExternalLink className="w-4 h-4 text-white/80 flex-none mt-0.5" />
              <span>
                Obtain your free API ID &amp; Hash from{' '}
                <a
                  href="https://my.telegram.org"
                  target="_blank"
                  rel="noreferrer"
                  className="text-white underline font-semibold hover:text-white/80"
                >
                  my.telegram.org
                </a>{' '}
                under &ldquo;API development tools&rdquo;.
              </span>
            </div>

            {credError && (
              <div className="p-3 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-xs text-rose-300 flex items-center space-x-2">
                <AlertCircle className="w-4 h-4 flex-none" />
                <span>{credError}</span>
              </div>
            )}

            <button
              type="submit"
              className="w-full py-3.5 rounded-full bg-white hover:bg-white/90 active:scale-95 text-black font-semibold text-sm shadow-xl transition-all focus:outline-none focus:ring-4 focus:ring-white/40"
            >
              Continue to Login
            </button>
          </form>
        )}

        {/* Step 2: Login Options (QR Code vs Phone) */}
        {step === 'login' && (
          <div className="space-y-6">
            {/* Segmented Control Pill Tabs */}
            <div className="grid grid-cols-2 p-1 rounded-full bg-white/10 border border-white/10 text-xs font-semibold">
              <button
                type="button"
                onClick={() => {
                  setLoginMethod('qr');
                  if (!qrCodeDataUrl && !qrLoading) initiateQRLogin();
                }}
                className={`py-2 rounded-full flex items-center justify-center space-x-1.5 transition-all ${
                  loginMethod === 'qr'
                    ? 'bg-white text-black shadow-md'
                    : 'text-white/70 hover:text-white'
                }`}
              >
                <QrCode className="w-4 h-4" />
                <span>QR Code</span>
              </button>
              <button
                type="button"
                onClick={() => setLoginMethod('phone')}
                className={`py-2 rounded-full flex items-center justify-center space-x-1.5 transition-all ${
                  loginMethod === 'phone'
                    ? 'bg-white text-black shadow-md'
                    : 'text-white/70 hover:text-white'
                }`}
              >
                <Phone className="w-4 h-4" />
                <span>Phone + OTP</span>
              </button>
            </div>

            {/* QR Code Tab */}
            {loginMethod === 'qr' && (
              qrNeeds2FA ? (
                <form onSubmit={handleQr2FASubmit} className="space-y-4 animate-scale-in">
                  <div className="p-4 rounded-2xl bg-white/5 border border-white/10 text-center space-y-2">
                    <div className="inline-flex p-2.5 rounded-xl bg-white/10 text-white">
                      <Key className="w-5 h-5" />
                    </div>
                    <h3 className="font-bold text-base text-white">Two-Step Verification</h3>
                    <p className="text-xs text-white/60">
                      Your account requires your Telegram Cloud 2FA Password.
                    </p>
                    {qr2FAHint && (
                      <span className="inline-block px-2.5 py-1 rounded bg-black/40 text-[11px] font-medium text-white/80 border border-white/10">
                        Hint: {qr2FAHint}
                      </span>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-white/80">2FA Password</label>
                    <input
                      type="password"
                      autoFocus
                      placeholder="Enter cloud password"
                      value={qr2FAPassword}
                      onChange={(e) => setQr2FAPassword(e.target.value)}
                      required
                      className="w-full px-4 py-3 rounded-2xl bg-white/10 border border-white/15 focus:border-white text-sm text-white focus:outline-none"
                    />
                  </div>

                  {qrError && (
                    <div className="p-3 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-xs text-rose-300 flex items-center space-x-2">
                      <AlertCircle className="w-4 h-4 flex-none" />
                      <span>{qrError}</span>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={qrLoading}
                    className="w-full py-3.5 rounded-full bg-white hover:bg-white/90 active:scale-95 text-black font-semibold text-sm shadow-xl transition-all flex items-center justify-center space-x-2"
                  >
                    {qrLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>Confirm &amp; Log In</span>}
                  </button>

                  <div className="text-center pt-2">
                    <button
                      type="button"
                      onClick={initiateQRLogin}
                      className="text-xs text-white/50 hover:text-white"
                    >
                      Back to QR Code
                    </button>
                  </div>
                </form>
              ) : (
                <div className="flex flex-col items-center justify-center space-y-4 py-2">
                  <div className="relative p-3 bg-white rounded-3xl shadow-2xl">
                    {qrLoading && (
                      <div className="w-64 h-64 flex flex-col items-center justify-center bg-white/95 rounded-2xl">
                        <Loader2 className="w-8 h-8 text-black animate-spin" />
                        <span className="text-xs font-semibold text-black mt-2">Generating QR...</span>
                      </div>
                    )}

                    {qrCodeDataUrl && (
                      <img
                        src={qrCodeDataUrl}
                        alt="Telegram QR Login"
                        className="w-64 h-64 rounded-2xl"
                      />
                    )}
                  </div>

                  <div className="text-center space-y-1">
                    <p className="text-xs font-medium text-white/80">
                      Telegram app &rarr; Settings &rarr; Devices &rarr; Link Desktop Device
                    </p>
                    <p className="text-[11px] text-white/40">Point your camera at this code to connect instantly.</p>
                  </div>

                  {qrError && (
                    <div className="text-xs text-rose-400 flex items-center space-x-1">
                      <AlertCircle className="w-3.5 h-3.5" />
                      <span>{qrError}</span>
                    </div>
                  )}

                  <button
                    onClick={initiateQRLogin}
                    className="text-xs text-white underline font-semibold hover:text-white/80"
                  >
                    Refresh QR Code
                  </button>
                </div>
              )
            )}

            {/* Phone + OTP Tab */}
            {loginMethod === 'phone' && (
              <div className="space-y-4">
                {!phoneCodeHash ? (
                  <form onSubmit={handleSendPhoneCode} className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-white/80">Phone Number (with Country Code)</label>
                      <input
                        type="tel"
                        autoFocus
                        placeholder="+1 234 567 8900"
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value)}
                        required
                        className="w-full px-4 py-3 rounded-2xl bg-white/10 border border-white/15 focus:border-white text-sm text-white placeholder-white/30 focus:outline-none"
                      />
                    </div>

                    {phoneError && (
                      <div className="p-3 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-xs text-rose-300 flex items-center space-x-2">
                        <AlertCircle className="w-4 h-4 flex-none" />
                        <span>{phoneError}</span>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={phoneLoading}
                      className="w-full py-3.5 rounded-full bg-white hover:bg-white/90 active:scale-95 text-black font-semibold text-sm shadow-xl transition-all flex items-center justify-center space-x-2"
                    >
                      {phoneLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>Send Code</span>}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handleVerifyPhoneCode} className="space-y-4">
                    {!needs2FA ? (
                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-white/80">Telegram Verification Code</label>
                        <input
                          type="text"
                          autoFocus
                          placeholder="12345"
                          value={otpCode}
                          onChange={(e) => setOtpCode(e.target.value)}
                          required
                          className="w-full px-4 py-3 rounded-2xl bg-white/10 border border-white/15 focus:border-white text-sm text-white tracking-widest text-center font-mono focus:outline-none"
                        />
                      </div>
                    ) : (
                      <div className="space-y-4 animate-scale-in">
                        <div className="p-3.5 rounded-2xl bg-white/5 border border-white/10 text-center space-y-1">
                          <div className="inline-flex p-2 rounded-xl bg-white/10 text-white mb-1">
                            <Key className="w-4 h-4" />
                          </div>
                          <h4 className="font-bold text-sm text-white">Two-Step Verification</h4>
                          <p className="text-xs text-white/60">
                            Enter your Telegram Cloud 2FA Password to complete sign in.
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-xs font-semibold text-white/80">2FA Password</label>
                          <input
                            type="password"
                            autoFocus
                            placeholder="Enter 2FA password"
                            value={password2FA}
                            onChange={(e) => setPassword2FA(e.target.value)}
                            required
                            className="w-full px-4 py-3 rounded-2xl bg-white/10 border border-white/15 focus:border-white text-sm text-white focus:outline-none"
                          />
                        </div>
                      </div>
                    )}

                    {phoneError && (
                      <div className="p-3 rounded-2xl bg-rose-500/15 border border-rose-500/30 text-xs text-rose-300 flex items-center space-x-2">
                        <AlertCircle className="w-4 h-4 flex-none" />
                        <span>{phoneError}</span>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={phoneLoading}
                      className="w-full py-3.5 rounded-full bg-white hover:bg-white/90 active:scale-95 text-black font-semibold text-sm shadow-xl transition-all flex items-center justify-center space-x-2"
                    >
                      {phoneLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <span>{needs2FA ? 'Confirm 2FA & Sign In' : 'Sign In'}</span>
                      )}
                    </button>

                    <div className="text-center pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setPhoneCodeHash(null);
                          setOtpCode('');
                          setPassword2FA('');
                          setNeeds2FA(false);
                          setPhoneError(null);
                        }}
                        className="text-xs text-white/50 hover:text-white transition-colors"
                      >
                        Change Phone Number
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
