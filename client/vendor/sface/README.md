# SFace (quantised)

`face_recognition_sface_2021dec_int8.onnx` is the int8 SFace face-recognition model from the
[OpenCV model zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface),
licensed under Apache-2.0 (see LICENSE). Paper: "SFace: Sigmoid-Constrained Hypersphere Loss for Robust Face Recognition".

It is kept in the repository so the app builds and installs without any internet access.
The guard's browser runs it on the device (client/src/lib/faceMatch.js); no face is ever sent anywhere.
