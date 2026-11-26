import sys, json, cv2, mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
src, model, out = sys.argv[1:4]
opts = vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=model),
    running_mode=vision.RunningMode.VIDEO, num_poses=1,
    min_pose_detection_confidence=0.5, min_tracking_confidence=0.5)
lm = vision.PoseLandmarker.create_from_options(opts)
cap = cv2.VideoCapture(src); fps = cap.get(cv2.CAP_PROP_FPS) or 60
frames=[]; i=0
while True:
    ok, img = cap.read()
    if not ok: break
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    r = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), int(i*1000/fps))
    if r.pose_world_landmarks:
        w=[[p.x,p.y,p.z,p.visibility] for p in r.pose_world_landmarks[0]]
        n=[[p.x,p.y] for p in r.pose_landmarks[0]]
        frames.append({'i':i,'w':w,'n':n})
    else: frames.append({'i':i,'w':None})
    i+=1
json.dump({'fps':fps,'frames':frames}, open(out,'w'))
det=sum(1 for f in frames if f['w']); print(f'{i} frames, {det} con pose')
