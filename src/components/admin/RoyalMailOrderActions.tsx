import React, { useState } from 'react';
import { 
  Truck, CheckCircle2, AlertCircle, RefreshCw, Printer, Download, 
  RotateCcw, ExternalLink, X, Compass, FileText, Send, ShieldCheck, Edit3, Check
} from 'lucide-react';
import { Order } from '../../types';

interface RoyalMailOrderActionsProps {
  order: Order;
  onUpdateOrder: (updatedOrder: Order) => void;
  onAddTimelineComment?: (comment: string) => void;
}

export const RoyalMailOrderActions: React.FC<RoyalMailOrderActionsProps> = ({
  order,
  onUpdateOrder,
  onAddTimelineComment
}) => {
  const [serviceCode, setServiceCode] = useState<string>(order.data?.royalMail?.serviceCode || 'TPS24');
  const [weightGrams, setWeightGrams] = useState<number>(350);
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [returning, setReturning] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Edit Real Tracking Modal / Input state
  const [showEditTrackingModal, setShowEditTrackingModal] = useState(false);
  const [customTrackingInput, setCustomTrackingInput] = useState('');
  const [customCarrierInput, setCustomCarrierInput] = useState(order.carrier || 'Royal Mail Tracked 24');
  const [savingTracking, setSavingTracking] = useState(false);

  // Tracking modal state
  const [showTrackingModal, setShowTrackingModal] = useState(false);
  const [trackingData, setTrackingData] = useState<any>(null);
  const [trackingLoading, setTrackingLoading] = useState(false);

  // Return label state
  const [returnLabelHtml, setReturnLabelHtml] = useState<string | null>(null);

  const trackingNumber = order.trackingNumber || order.trackingId || order.data?.royalMail?.trackingNumber;
  const isShipped = Boolean(trackingNumber && (order.fulfillmentStatus === 'Shipped' || order.fulfillmentStatus === 'Fulfilled'));
  const isSimulated = Boolean(order.data?.royalMail?.isSimulated || (trackingNumber && trackingNumber.startsWith('RM') && trackingNumber.length === 13 && !order.data?.royalMail?.isRealApi));

  const handleSaveRealTracking = async (newTracking: string, carrierName: string) => {
    const trimmed = newTracking.trim();
    if (!trimmed) {
      alert('Please enter a valid tracking number.');
      return;
    }
    setSavingTracking(true);
    setStatusMessage(null);
    try {
      const updatedOrder: Order = {
        ...order,
        fulfillmentStatus: 'Shipped',
        trackingNumber: trimmed,
        trackingId: trimmed,
        carrier: carrierName || 'Royal Mail Tracked 24',
        data: {
          ...(order.data || {}),
          royalMail: {
            ...(order.data?.royalMail || {}),
            trackingNumber: trimmed,
            carrier: carrierName || 'Royal Mail Tracked 24',
            shippedAt: order.data?.royalMail?.shippedAt || new Date().toISOString(),
            isSimulated: false,
            isRealApi: true
          }
        }
      };

      const res = await fetch(`/api/orders/${order.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedOrder)
      });

      if (!res.ok) {
        throw new Error('Failed to update tracking on server');
      }

      onUpdateOrder(updatedOrder);
      setShowEditTrackingModal(false);
      setStatusMessage({
        type: 'success',
        text: `Real tracking number updated to ${trimmed}.`
      });

      if (onAddTimelineComment) {
        onAddTimelineComment(`Updated Royal Mail tracking number to: ${trimmed}`);
      }
    } catch (err: any) {
      setStatusMessage({
        type: 'error',
        text: err.message || 'Failed to save tracking number'
      });
    } finally {
      setSavingTracking(false);
    }
  };

  const handleCreateShipment = async () => {
    setCreating(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/royalmail/create-shipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: order.id,
          serviceCode,
          weightGrams
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setStatusMessage({
          type: 'success',
          text: `Royal Mail Shipment created! Tracking #: ${data.trackingNumber}. Resend dispatch email & Klaviyo event sent.`
        });

        const updated: Order = {
          ...order,
          fulfillmentStatus: 'Shipped',
          trackingNumber: data.trackingNumber,
          trackingId: data.trackingNumber,
          carrier: data.carrier || 'Royal Mail Tracked 24',
          data: {
            ...(order.data || {}),
            royalMail: {
              royalMailOrderId: data.royalMailOrderId,
              trackingNumber: data.trackingNumber,
              serviceCode: data.serviceName,
              carrier: data.carrier,
              shippedAt: new Date().toISOString(),
              isSimulated: data.isSimulated,
              isRealApi: !data.isSimulated
            }
          }
        };

        onUpdateOrder(updated);
        if (onAddTimelineComment) {
          onAddTimelineComment(`Created Royal Mail shipment (${data.serviceName}). Tracking number: ${data.trackingNumber}`);
        }
      } else {
        throw new Error(data.error || 'Failed to create Royal Mail shipment');
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Shipment creation failed' });
    } finally {
      setCreating(false);
    }
  };

  const handlePrintLabel = () => {
    const printUrl = `/api/royalmail/label/${order.id}/html`;
    const win = window.open(printUrl, '_blank', 'width=600,height=800');
    if (win) {
      win.focus();
    }
  };

  const handleTrackShipment = async () => {
    if (!trackingNumber) return;
    setTrackingLoading(true);
    setShowTrackingModal(true);
    try {
      const res = await fetch(`/api/royalmail/track/${trackingNumber}`);
      const data = await res.json();
      setTrackingData(data);
    } catch (err: any) {
      console.error('Failed to fetch tracking details:', err);
    } finally {
      setTrackingLoading(false);
    }
  };

  const handleCreateReturnLabel = async () => {
    setReturning(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/royalmail/create-return-label', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: order.id })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setReturnLabelHtml(data.labelHtml);
        setStatusMessage({
          type: 'success',
          text: `Royal Mail Pre-Paid Return Label generated (${data.returnTrackingNumber}).`
        });
        if (onAddTimelineComment) {
          onAddTimelineComment(`Generated Royal Mail Pre-Paid Return Label: ${data.returnTrackingNumber}`);
        }
      } else {
        throw new Error(data.error || 'Failed to generate return label');
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Return label creation failed' });
    } finally {
      setReturning(false);
    }
  };

  const handleCancelShipment = async () => {
    if (!confirm('Are you sure you want to cancel / clear this Royal Mail shipment? You will be able to enter a real tracking number or regenerate shipment.')) return;
    setCancelling(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/royalmail/cancel-shipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: order.id,
          royalMailOrderId: order.data?.royalMail?.royalMailOrderId
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setStatusMessage({ type: 'success', text: 'Royal Mail shipment cleared.' });
        const updated: Order = {
          ...order,
          fulfillmentStatus: 'Unfulfilled',
          trackingNumber: undefined,
          trackingId: undefined,
          carrier: undefined,
          data: {
            ...(order.data || {}),
            royalMail: undefined
          }
        };

        await fetch(`/api/orders/${order.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updated)
        });

        onUpdateOrder(updated);
        if (onAddTimelineComment) {
          onAddTimelineComment('Cancelled / cleared Royal Mail shipment details.');
        }
      } else {
        throw new Error(data.error || 'Failed to cancel shipment');
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Failed to cancel shipment' });
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="bg-gradient-to-br from-rose-50/80 via-white to-slate-50 border border-rose-200/90 rounded-2xl p-5 space-y-4 shadow-sm relative">
      
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 border-b border-rose-100 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-rose-600 text-white flex items-center justify-center font-black text-xs shadow-sm">
            RM
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="font-extrabold text-sm text-slate-900 tracking-tight">Royal Mail Click & Drop®</h4>
              <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded bg-rose-100 text-rose-800 border border-rose-200">
                Pouch-Supply
              </span>
            </div>
            <p className="text-[11px] text-slate-500 font-medium">
              Official Courier Dispatch • Address Validation • Auto Email & Tracking
            </p>
          </div>
        </div>

        {isShipped && trackingNumber && (
          <a
            href={`https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-bold text-rose-700 hover:text-rose-900 underline flex items-center gap-1"
          >
            <span>Track on RoyalMail.com</span>
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {/* Status Feedback Banner */}
      {statusMessage && (
        <div className={`p-3 rounded-xl border text-xs font-bold flex items-center gap-2 ${
          statusMessage.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-rose-50 border-rose-200 text-rose-900'
        }`}>
          {statusMessage.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 text-rose-600 shrink-0" />
          )}
          <span>{statusMessage.text}</span>
        </div>
      )}

      {/* UNFULFILLED: Create Shipment Controls */}
      {!isShipped && (
        <div className="space-y-3 pt-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] font-extrabold text-slate-600 uppercase tracking-wider block mb-1">
                Postage Service Code
              </label>
              <select
                value={serviceCode}
                onChange={(e) => setServiceCode(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-rose-500 shadow-2xs"
              >
                <option value="TPS24">Royal Mail Tracked 24® (£4.95)</option>
                <option value="TPS48">Royal Mail Tracked 48® (£3.85)</option>
                <option value="SD1">Special Delivery Guaranteed 1pm® (£8.95)</option>
                <option value="CRL2">Royal Mail 24 Business Parcel (£4.25)</option>
                <option value="MP1">Royal Mail International Tracked (£12.50)</option>
              </select>
            </div>

            <div>
              <label className="text-[10px] font-extrabold text-slate-600 uppercase tracking-wider block mb-1">
                Package Weight (Grams)
              </label>
              <input
                type="number"
                value={weightGrams}
                onChange={(e) => setWeightGrams(parseInt(e.target.value, 10) || 350)}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-rose-500 shadow-2xs"
              />
            </div>
          </div>

          <button
            onClick={handleCreateShipment}
            disabled={creating}
            className="w-full py-2.5 px-4 bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {creating ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                <span>Creating Royal Mail Shipment & Dispatching Notifications...</span>
              </>
            ) : (
              <>
                <Truck className="h-4 w-4" />
                <span>📦 Create Royal Mail Shipment & Mark as Shipped</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* SHIPPED: Active Tracking & Label Management */}
      {isShipped && (
        <div className="space-y-3 pt-1">
          {/* Simulated / Preview Tracking Notice */}
          {isSimulated && (
            <div className="p-3 bg-amber-50/90 border border-amber-200 rounded-xl flex items-start gap-2.5 text-xs text-amber-900">
              <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1 space-y-1">
                <p className="font-bold">
                  ⚠️ Preview / Test Tracking Reference: <code className="font-mono bg-amber-100/80 px-1 py-0.5 rounded text-amber-950">{trackingNumber}</code>
                </p>
                <p className="text-[11px] text-amber-800 leading-relaxed">
                  This test reference was generated for store simulation and is not yet registered in Royal Mail's public system. To link your real Royal Mail parcel barcode, click <strong>"Enter Real Tracking #"</strong> below or connect your live Click & Drop API Key.
                </p>
              </div>
            </div>
          )}

          <div className="p-3 bg-white border border-rose-200 rounded-xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 shadow-2xs">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
                  Royal Mail Tracking Number
                </span>
                {isSimulated ? (
                  <span className="text-[9px] font-black uppercase bg-amber-100 text-amber-800 border border-amber-200 px-1.5 py-0.2 rounded">
                    Test Mode
                  </span>
                ) : (
                  <span className="text-[9px] font-black uppercase bg-emerald-100 text-emerald-800 border border-emerald-200 px-1.5 py-0.2 rounded">
                    Live Verified
                  </span>
                )}
              </div>
              <span className="text-sm font-mono font-black text-rose-950 tracking-wider block mt-0.5">
                {trackingNumber}
              </span>
              <span className="text-xs text-slate-500 font-semibold block">
                {order.carrier || 'Royal Mail Tracked 24'}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => {
                  setCustomTrackingInput(trackingNumber || '');
                  setCustomCarrierInput(order.carrier || 'Royal Mail Tracked 24');
                  setShowEditTrackingModal(true);
                }}
                className="px-3 py-1.5 bg-white hover:bg-slate-50 border border-slate-300 text-slate-800 font-bold text-xs rounded-lg flex items-center gap-1 transition-colors shadow-2xs cursor-pointer"
                title="Enter or update real Royal Mail tracking number"
              >
                <Edit3 className="h-3.5 w-3.5 text-slate-600" />
                <span>Enter Real Tracking #</span>
              </button>

              <button
                onClick={handlePrintLabel}
                className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs rounded-lg flex items-center gap-1 transition-colors shadow-2xs cursor-pointer"
              >
                <Printer className="h-3.5 w-3.5" />
                <span>Print Label</span>
              </button>

              <button
                onClick={handleTrackShipment}
                className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-lg flex items-center gap-1 transition-colors shadow-2xs cursor-pointer"
              >
                <Compass className="h-3.5 w-3.5" />
                <span>Track Package</span>
              </button>

              <button
                onClick={handleCreateReturnLabel}
                disabled={returning}
                className="px-3 py-1.5 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 font-bold text-xs rounded-lg flex items-center gap-1 transition-colors shadow-2xs cursor-pointer"
              >
                {returning ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                <span>Return Label</span>
              </button>

              <button
                onClick={handleCancelShipment}
                disabled={cancelling}
                className="px-2.5 py-1.5 bg-white hover:bg-rose-50 border border-rose-200 text-rose-700 font-bold text-xs rounded-lg flex items-center gap-1 transition-colors cursor-pointer"
                title="Cancel / Reset Royal Mail Shipment"
              >
                {cancelling ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                <span>Clear</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Real Tracking Number Modal */}
      {showEditTrackingModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 space-y-4 border border-slate-200 shadow-2xl relative animate-scale">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-rose-600 text-white flex items-center justify-center font-black text-xs">RM</div>
                <div>
                  <h3 className="font-black text-sm text-slate-900">Enter Real Royal Mail Tracking Number</h3>
                  <p className="text-[10px] text-slate-400 font-semibold">Order #{order.id} • {order.customerName}</p>
                </div>
              </div>
              <button 
                onClick={() => !savingTracking && setShowEditTrackingModal(false)}
                disabled={savingTracking}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1 text-slate-600 text-[11px]">
                <p className="font-bold text-slate-800">Paste your official Royal Mail barcode:</p>
                <p>• Standard 13-character code (e.g. <code>JG123456789GB</code>, <code>GB123456789</code>)</p>
                <p>• 21-character 2D barcode from your Click & Drop or Post Office receipt</p>
              </div>

              <div>
                <label className="block font-black text-slate-700 uppercase tracking-wider text-[10px] mb-1">
                  Royal Mail Tracking Reference
                </label>
                <input
                  type="text"
                  value={customTrackingInput}
                  onChange={(e) => setCustomTrackingInput(e.target.value.toUpperCase())}
                  placeholder="e.g. JG123456789GB"
                  className="w-full border border-slate-200 p-2.5 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 font-mono text-xs font-bold text-slate-900 uppercase"
                  autoFocus
                />
              </div>

              <div>
                <label className="block font-black text-slate-700 uppercase tracking-wider text-[10px] mb-1">
                  Postage Service / Carrier Name
                </label>
                <input
                  type="text"
                  value={customCarrierInput}
                  onChange={(e) => setCustomCarrierInput(e.target.value)}
                  placeholder="e.g. Royal Mail Tracked 24®"
                  className="w-full border border-slate-200 p-2.5 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 text-xs font-medium text-slate-900"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowEditTrackingModal(false)}
                disabled={savingTracking}
                className="py-2 px-3.5 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 text-xs font-bold rounded-lg cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleSaveRealTracking(customTrackingInput, customCarrierInput)}
                disabled={savingTracking || !customTrackingInput.trim()}
                className="py-2 px-4 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 cursor-pointer shadow-md transition-colors disabled:opacity-50"
              >
                {savingTracking ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    <span>Save Real Tracking Number</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Return Label Printable Preview Modal */}
      {returnLabelHtml && (
        <div className="p-4 bg-white border border-rose-300 rounded-xl space-y-3">
          <div className="flex justify-between items-center border-b border-slate-100 pb-2">
            <span className="text-xs font-black text-rose-900 uppercase">Pre-Paid Royal Mail Return Label Ready</span>
            <button onClick={() => setReturnLabelHtml(null)} className="text-slate-400 hover:text-slate-600">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => {
                const printWindow = window.open('', '_blank');
                if (printWindow) {
                  printWindow.document.write(returnLabelHtml);
                  printWindow.document.close();
                }
              }}
              className="px-3 py-1.5 bg-rose-600 text-white font-bold text-xs rounded-lg flex items-center gap-1"
            >
              <Printer className="h-3.5 w-3.5" /> Print Pre-Paid Return Label
            </button>
          </div>
        </div>
      )}

      {/* Live Tracking Modal */}
      {showTrackingModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 space-y-4 border border-slate-200 shadow-2xl relative">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <Compass className="h-5 w-5 text-rose-600" />
                <h3 className="font-black text-base text-slate-900">Royal Mail Live Tracking</h3>
              </div>
              <button onClick={() => setShowTrackingModal(false)} className="text-slate-400 hover:text-slate-600 cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>

            {trackingLoading ? (
              <div className="p-8 text-center text-slate-500">
                <RefreshCw className="h-6 w-6 animate-spin mx-auto text-rose-600 mb-2" />
                <p className="text-xs font-bold">Connecting to Royal Mail Tracking Network...</p>
              </div>
            ) : trackingData ? (
              <div className="space-y-4">
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl">
                  <div className="flex justify-between items-center text-xs font-bold text-slate-800">
                    <span>Tracking #: <code className="font-mono text-rose-900 select-all">{trackingData.trackingNumber || trackingNumber}</code></span>
                    <span className="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded text-[10px] uppercase font-black">
                      {trackingData.status || 'Active'}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-600 mt-1">Est. Delivery: {trackingData.estimatedDelivery || 'Within 24-48 Hours'}</p>
                  
                  <div className="pt-2 mt-2 border-t border-rose-200/60 flex justify-end">
                    <a
                      href={`https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(trackingData.trackingNumber || trackingNumber)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 px-3 py-1.5 rounded-lg transition-colors shadow-2xs"
                    >
                      <span>Open on RoyalMail.com Official Tracker</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xs font-extrabold text-slate-700 uppercase tracking-wider">Tracking History Checkpoints</h4>
                  <div className="space-y-2 border-l-2 border-rose-200 pl-4">
                    {trackingData.history?.map((h: any, idx: number) => (
                      <div key={idx} className="relative pb-2">
                        <div className="absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full bg-rose-600 ring-4 ring-rose-100" />
                        <div className="text-xs font-bold text-slate-900">{h.status} - {h.location}</div>
                        <div className="text-[11px] text-slate-500">{h.description}</div>
                        <div className="text-[10px] text-slate-400 font-mono mt-0.5">{h.timestamp || h.date}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500">No tracking history returned.</p>
            )}
          </div>
        </div>
      )}

    </div>
  );
};
