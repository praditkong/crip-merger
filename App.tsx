import React, { useState, useRef, useEffect } from 'react';
import { Button } from './components/Button';
import { Download, Folder, Play, RefreshCw, Film } from 'lucide-react';

interface ProcessStatus {
  state: 'idle' | 'processing' | 'completed' | 'error';
  message: string;
  progress: number;
}

const App: React.FC = () => {
  const [files, setFiles] = useState<File[]>([]);
  const [folderName, setFolderName] = useState<string>('video');
  const [status, setStatus] = useState<ProcessStatus>({ state: 'idle', message: '', progress: 0 });
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [finalMimeType, setFinalMimeType] = useState<string>('');

  // Hidden references for processing
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processingRef = useRef<boolean>(false);

  // Constants
  const PREFERRED_FORMAT = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'; // H.264 + AAC
  const FALLBACK_FORMAT = 'video/webm; codecs="vp8, opus"';

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close();
      }
    };
  }, [downloadUrl]);

  const handleFolderSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0) return;

    // Filter video files and sort them naturally
    const videoFiles = (Array.from(fileList) as File[])
      .filter(file => file.type.startsWith('video/'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    if (videoFiles.length === 0) {
      setStatus({ state: 'error', message: 'No video files found in the selected folder.', progress: 0 });
      return;
    }

    // Extract folder name from the first file's relative path
    // webkitRelativePath format: "FolderName/FileName.mp4"
    const path = videoFiles[0].webkitRelativePath;
    const extractedFolderName = path.split('/')[0] || 'merged_video';

    setFiles(videoFiles);
    setFolderName(extractedFolderName);
    setDownloadUrl(null);
    setStatus({ state: 'idle', message: `Ready to merge ${videoFiles.length} clips from "${extractedFolderName}"`, progress: 0 });
  };

  const getSupportedMimeType = () => {
    if (MediaRecorder.isTypeSupported(PREFERRED_FORMAT)) {
      return PREFERRED_FORMAT;
    } else if (MediaRecorder.isTypeSupported('video/mp4')) {
      return 'video/mp4';
    } else {
      return FALLBACK_FORMAT;
    }
  };

  const startProcessing = async () => {
    if (files.length === 0 || !canvasRef.current) return;

    processingRef.current = true;
    setStatus({ state: 'processing', message: 'Initializing processing engine...', progress: 0 });

    let mediaRecorder: MediaRecorder | null = null;
    
    try {
      const mimeType = getSupportedMimeType();
      setFinalMimeType(mimeType);
      
      console.log(`Using format: ${mimeType}`);

      // 1. Setup Audio Context
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioCtx;
      
      // Resume context if suspended (browser policy)
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      
      // Destination node to record audio (not speakers)
      const destNode = audioCtx.createMediaStreamDestination();

      // 2. Setup Canvas
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error("Could not get canvas context");

      // 3. Prepare Stream & Recorder
      // Capture stream from canvas (video)
      const canvasStream = canvas.captureStream(30); // 30 FPS
      
      // Combine video track from canvas and audio track from destination
      const combinedStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...destNode.stream.getAudioTracks()
      ]);

      mediaRecorder = new MediaRecorder(combinedStream, {
        mimeType: mimeType,
        videoBitsPerSecond: 5000000 // 5 Mbps for decent quality
      });
      
      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        setDownloadUrl(url);
        setStatus({ state: 'completed', message: 'Processing complete!', progress: 100 });
        processingRef.current = false;
        
        // Cleanup audio context
        if (audioCtx.state !== 'closed') audioCtx.close();
      };

      mediaRecorder.start();
      
      let dimensionsSet = false;

      // 4. Sequential Processing Loop
      for (let i = 0; i < files.length; i++) {
        if (!processingRef.current) break; // User cancelled

        const file = files[i];
        setStatus({ 
          state: 'processing', 
          message: `Processing clip ${i + 1}/${files.length}: ${file.name}`, 
          progress: Math.round((i / files.length) * 100) 
        });

        await new Promise<void>((resolve, reject) => {
          // Create a NEW video element for each clip to avoid AudioContext InvalidStateError
          const video = document.createElement('video');
          video.muted = false; // Important for AudioContext capture
          video.playsInline = true;
          video.crossOrigin = "anonymous";
          
          const fileURL = URL.createObjectURL(file);
          video.src = fileURL;

          // Attach to DOM invisibly to ensure browser priority
          video.style.display = 'none';
          document.body.appendChild(video);
          
          let sourceNode: MediaElementAudioSourceNode | null = null;
          let drawRequestId: number;

          video.onloadedmetadata = () => {
            if (!dimensionsSet) {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              dimensionsSet = true;
            } else {
               // Ensure aspect ratio is maintained by drawing letterbox or filling?
               // For simplicity in this v1, we assume similar sizes or we just scale to fit first clip's dimensions
            }
          };

          const cleanup = () => {
            cancelAnimationFrame(drawRequestId);
            if (sourceNode) {
              try { sourceNode.disconnect(); } catch (e) {}
            }
            video.remove(); // Remove from DOM
            URL.revokeObjectURL(fileURL);
          };

          video.oncanplay = async () => {
             // Avoid double triggering
             video.oncanplay = null;

             try {
                // Create source for this SPECIFIC video element
                sourceNode = audioCtx.createMediaElementSource(video);
                sourceNode.connect(destNode);
             } catch (e) {
                console.warn("Audio source creation failed:", e);
             }

             try {
               await video.play();
               drawFrame();
             } catch (err) {
               cleanup();
               reject(err);
             }
          };

          const drawFrame = () => {
            if (video.paused || video.ended) return;
            // Draw video frame to canvas
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            drawRequestId = requestAnimationFrame(drawFrame);
          };

          video.onended = () => {
            cleanup();
            resolve();
          };

          video.onerror = (e) => {
            cleanup();
            reject(`Error playing file ${file.name}`);
          };
        });
      }

      // Stop everything
      if (mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      
    } catch (error: any) {
      console.error(error);
      setStatus({ state: 'error', message: `Error: ${error.message || 'Unknown error'}`, progress: 0 });
      processingRef.current = false;
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    }
  };

  const handleDownload = () => {
    if (!downloadUrl) return;
    
    const ext = finalMimeType.includes('mp4') ? 'mp4' : 'webm';
    const fileName = `${folderName}.${ext}`;
    
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6 text-gray-100 font-sans">
      
      <div className="max-w-xl w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="bg-blue-600 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-blue-500/30">
            <Film className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight">Clip Merger</h1>
          <p className="text-gray-400">Select a folder, merge clips, download.</p>
        </div>

        {/* Card */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl p-8 space-y-6">
          
          {/* Step 1: Upload */}
          <div className="space-y-4">
            <label className="block w-full group cursor-pointer">
              <div className="relative flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-gray-700 rounded-xl hover:border-blue-500 hover:bg-gray-800 transition-all duration-300 bg-gray-900/50">
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <Folder className="w-10 h-10 mb-3 text-gray-500 group-hover:text-blue-400 transition-colors" />
                  <p className="mb-2 text-sm text-gray-400 font-medium">Click to select folder</p>
                  <p className="text-xs text-gray-600">Supports .mp4, .webm, .mov</p>
                </div>
                <input 
                  type="file" 
                  className="hidden" 
                  {...({ webkitdirectory: "", directory: "" } as any)}
                  onChange={handleFolderSelect} 
                />
              </div>
            </label>
            
            {files.length > 0 && status.state === 'idle' && (
              <div className="bg-gray-800/50 rounded-lg p-4 flex items-center justify-between border border-gray-700">
                <div>
                  <p className="text-sm font-semibold text-white">Folder: {folderName}</p>
                  <p className="text-xs text-gray-400">{files.length} clips found</p>
                </div>
                <Button onClick={startProcessing}>
                  <Play className="w-4 h-4 mr-2" fill="currentColor" />
                  Start Merge
                </Button>
              </div>
            )}
          </div>

          {/* Step 2: Processing UI */}
          {(status.state === 'processing' || status.state === 'completed' || status.state === 'error') && (
             <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="flex justify-between text-sm font-medium text-gray-300">
                  <span>{status.message}</span>
                  <span>{status.progress}%</span>
                </div>
                
                {/* Progress Bar */}
                <div className="w-full bg-gray-800 rounded-full h-2.5 overflow-hidden">
                  <div 
                    className={`h-2.5 rounded-full transition-all duration-300 ${
                      status.state === 'error' ? 'bg-red-500' : 
                      status.state === 'completed' ? 'bg-green-500' : 'bg-blue-600'
                    }`}
                    style={{ width: `${status.progress}%` }}
                  ></div>
                </div>

                {status.state === 'error' && (
                  <div className="text-red-400 text-sm bg-red-900/20 p-3 rounded-lg border border-red-900/50">
                    {status.message}
                  </div>
                )}
             </div>
          )}

          {/* Step 3: Success & Download */}
          {status.state === 'completed' && downloadUrl && (
            <div className="space-y-4 pt-4 border-t border-gray-800">
              <div className="flex flex-col gap-3">
                 <Button onClick={handleDownload} variant="primary" className="w-full py-4 text-lg shadow-lg shadow-blue-900/20">
                    <Download className="w-5 h-5" />
                    Download {folderName}.{finalMimeType.includes('mp4') ? 'mp4' : 'webm'}
                 </Button>
                 <Button onClick={() => {
                   setFiles([]);
                   setDownloadUrl(null);
                   setStatus({ state: 'idle', message: '', progress: 0 });
                 }} variant="secondary" className="w-full">
                    <RefreshCw className="w-4 h-4" />
                    Start Over
                 </Button>
              </div>
              <p className="text-center text-xs text-gray-500">
                The file will be named based on your source folder.
              </p>
            </div>
          )}
        </div>
        
        {/* Hidden Elements for Processing */}
        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>
  );
};

export default App;